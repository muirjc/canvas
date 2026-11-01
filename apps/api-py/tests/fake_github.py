"""canvas-1bty.11: an in-memory GitHub for tests, a Python port of apps/api/tests/helpers/fake-github.ts.

It answers the GitHubClient's requests in-process (an httpx.MockTransport, no sockets) and is as strict as
the real GitHub: App JWTs are verified with the test public key (RS256, issuer, expiry <= 10 minutes, not
issued in the future); installation tokens are checked on every other call, including that the repository is
inside the token's repository_ids and that the token's permissions allow the operation. Git is modelled just
enough: repos -> branches -> commits -> trees (a path -> content map). A tree's sha is a hash of its content
map, so creating a tree from base_tree + entries that change nothing returns the SAME sha (the "up to date"
path).
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, unquote

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey, RSAPublicKey

from canvas_api.config import GitHubAppConfig

DEFAULT_PERMISSIONS = {"contents": "write", "pull_requests": "write", "metadata": "read"}
#: The address the fake answers for. Never connected to (the transport is in-process), but it has to be a
#: URL GITHUB_APP_API_URL accepts.
FAKE_URL = "http://127.0.0.1:9"


@dataclass
class FakeInstallation:
    id: int
    account: str
    permissions: dict[str, str]
    repository_selection: str = "selected"
    repo_ids: set[int] = field(default_factory=set)


@dataclass
class FakeCommit:
    sha: str
    message: str
    tree: str
    parents: list[str]


@dataclass
class FakeReview:
    login: str
    state: str  # APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING


@dataclass
class FakePull:
    number: int
    title: str
    body: str
    head: str
    base: str
    state: str = "open"
    merged: bool = False
    merged_at: str | None = None
    merged_by: str | None = None
    merge_commit_sha: str | None = None
    closed_at: str | None = None
    reviews: list[FakeReview] = field(default_factory=list)
    requested_reviewers: list[str] = field(default_factory=list)
    requested_teams: list[str] = field(default_factory=list)
    comments: list[str] = field(default_factory=list)
    #: Who opened it (default: the App's bot account).
    author: str | None = None
    #: owner/name of the head branch's repository (default: this repository; set for a fork).
    head_repo: str | None = None


@dataclass
class FakeRepo:
    id: int
    owner: str
    name: str
    default_branch: str
    installation_id: int
    private: bool = True
    branches: dict[str, str] = field(default_factory=dict)
    commits: dict[str, FakeCommit] = field(default_factory=dict)
    trees: dict[str, dict[str, str]] = field(default_factory=dict)
    pulls: dict[int, FakePull] = field(default_factory=dict)
    next_pull: int = 1
    #: commit sha -> check runs / commit statuses reported on it
    check_runs: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    statuses: dict[str, list[dict[str, Any]]] = field(default_factory=dict)


@dataclass
class RecordedRequest:
    method: str
    path: str
    auth: str  # app | installation | none
    body: Any


@dataclass
class TokenRequest:
    installation_id: int
    body: dict[str, Any]


@dataclass
class IssuedToken:
    installation_id: int
    repo_ids: set[int] | None
    permissions: dict[str, str]
    expires_at: float


class HttpError(Exception):
    def __init__(self, status: int, message: str, headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.headers = headers or {}


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "surrogatepass"), usedforsecurity=False).hexdigest()


def tree_sha(files: dict[str, str]) -> str:
    return sha1(json.dumps(sorted(files.items()), ensure_ascii=False))


def _b64url_decode(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def _iso(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ms) % 1000:03d}Z"


def _now_iso() -> str:
    return _iso(time.time() * 1000)


class FakeGitHub:
    app_id = "12345"
    url = FAKE_URL

    def __init__(self) -> None:
        self.private_key: RSAPrivateKey = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.public_key: RSAPublicKey = self.private_key.public_key()
        self.installations: dict[int, FakeInstallation] = {}
        self.repos: dict[int, FakeRepo] = {}
        self.requests: list[RecordedRequest] = []
        self.token_requests: list[TokenRequest] = []
        self._tokens: dict[str, IssuedToken] = {}
        self._next_repo_id = 1001
        self._lock = threading.RLock()
        #: Called just before a branch is moved (PATCH git/refs), so a test can race it.
        self.before_ref_update: Callable[[FakeRepo, str], None] | None = None
        #: Delays every response by this many ms (to make concurrent requests overlap).
        self.latency_ms = 0
        #: When set, every request answers with this status (e.g. 500, 429) and headers.
        self.fail_with: tuple[int, dict[str, str]] | None = None

    # ---- wiring --------------------------------------------------------------------------------------

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def config(self) -> GitHubAppConfig:
        """The App configuration pointing at this fake (what Settings.github would build)."""
        return GitHubAppConfig(self.app_id, self.private_key, self.url)

    def private_key_pem(self) -> str:
        return self.private_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        ).decode()

    def reset(self) -> None:
        """Between tests: no installations, repos, records, failures or hooks."""
        self.clear_records()
        self.installations.clear()
        self.repos.clear()
        self.latency_ms = 0
        self.fail_with = None
        self.before_ref_update = None

    # ---- setup / test helpers ------------------------------------------------------------------------

    def add_installation(
        self, *, id: int | None = None, account: str = "acme", permissions: dict[str, str] | None = None
    ) -> FakeInstallation:
        installation_id = id if id is not None else 7000 + len(self.installations) + 1
        installation = FakeInstallation(
            installation_id, account, dict(permissions if permissions is not None else DEFAULT_PERMISSIONS)
        )
        self.installations[installation_id] = installation
        return installation

    def add_repo(
        self,
        installation_id: int,
        *,
        name: str,
        owner: str | None = None,
        default_branch: str = "main",
        files: dict[str, str] | None = None,
    ) -> FakeRepo:
        """A repository on an installation, with a base branch holding one commit (a README by default)."""
        installation = self.installations.get(installation_id)
        if installation is None:
            raise KeyError(f"no installation {installation_id}")
        repo = FakeRepo(self._next_repo_id, owner or installation.account, name, default_branch, installation_id)
        self._next_repo_id += 1
        content = dict(files if files is not None else {"README.md": "# repo\n"})
        tree = tree_sha(content)
        repo.trees[tree] = content
        commit = FakeCommit(sha1(f"root:{repo.id}:{tree}"), "Initial commit", tree, [])
        repo.commits[commit.sha] = commit
        repo.branches[default_branch] = commit.sha
        self.repos[repo.id] = repo
        installation.repo_ids.add(repo.id)
        return repo

    def remove_repo_from_installation(self, repo: FakeRepo) -> None:
        installation = self.installations.get(repo.installation_id)
        if installation:
            installation.repo_ids.discard(repo.id)

    def add_repo_to_installation(self, repo: FakeRepo) -> None:
        installation = self.installations.get(repo.installation_id)
        if installation:
            installation.repo_ids.add(repo.id)

    def remove_installation(self, installation_id: int) -> None:
        self.installations.pop(installation_id, None)

    def rename_repo(self, repo: FakeRepo, name: str) -> None:
        repo.name = name

    def files(self, repo: FakeRepo, branch: str) -> dict[str, str] | None:
        """The files on a branch (path -> content), or None if there is no such branch."""
        sha = repo.branches.get(branch)
        return repo.trees.get(repo.commits[sha].tree) if sha else None

    def commits_on(self, repo: FakeRepo, branch: str) -> list[FakeCommit]:
        """Commits reachable from a branch's head, newest first (first-parent)."""
        out: list[FakeCommit] = []
        sha = repo.branches.get(branch)
        while sha:
            commit = repo.commits[sha]
            out.append(commit)
            sha = commit.parents[0] if commit.parents else None
        return out

    def head_of(self, repo: FakeRepo, branch: str) -> str:
        sha = repo.branches.get(branch)
        if not sha:
            raise KeyError(f"no branch {branch}")
        return sha

    def merge_pull(self, repo: FakeRepo, number: int, *, by: str = "reviewer", apply_to_base: bool = True) -> None:
        """Merges a pull request the way GitHub's fast-forward-able merge would: the base moves to the head."""
        pull = self.pull(repo, number)
        head = repo.branches[pull.head]
        if apply_to_base:
            repo.branches[pull.base] = head
        pull.state = "closed"
        pull.merged = True
        pull.merged_at = _now_iso()
        pull.closed_at = pull.merged_at
        pull.merged_by = by
        pull.merge_commit_sha = head

    def close_pull(self, repo: FakeRepo, number: int) -> None:
        pull = self.pull(repo, number)
        pull.state = "closed"
        pull.closed_at = _now_iso()

    def force_move_branch(self, repo: FakeRepo, branch: str, sha: str) -> None:
        """Points a branch at some other commit, even if that drops commits (a force-push)."""
        repo.branches[branch] = sha

    def make_commit(
        self, repo: FakeRepo, parent_sha: str, files: dict[str, str], message: str = "outside change"
    ) -> str:
        """A commit whose parent is `parent_sha` and which writes `files`, without moving any branch."""
        parent = repo.commits[parent_sha]
        merged = {**repo.trees[parent.tree], **files}
        tree = tree_sha(merged)
        repo.trees[tree] = merged
        commit = FakeCommit(sha1(f"{tree}|{parent_sha}|{message}"), message, tree, [parent_sha])
        repo.commits[commit.sha] = commit
        return commit.sha

    def add_review(self, repo: FakeRepo, number: int, login: str, state: str) -> None:
        self.pull(repo, number).reviews.append(FakeReview(login, state))

    def request_reviewer(self, repo: FakeRepo, number: int, login: str) -> None:
        self.pull(repo, number).requested_reviewers.append(login)

    def request_team(self, repo: FakeRepo, number: int, slug: str) -> None:
        self.pull(repo, number).requested_teams.append(slug)

    def set_check_runs(self, repo: FakeRepo, sha: str, runs: list[dict[str, Any]]) -> None:
        """runs: {"name", "status": queued|in_progress|completed, "conclusion"}."""
        repo.check_runs[sha] = runs

    def set_statuses(self, repo: FakeRepo, sha: str, statuses: list[dict[str, Any]]) -> None:
        """statuses: {"context", "state": error|failure|pending|success}."""
        repo.statuses[sha] = statuses

    def grant_checks(self, installation_id: int) -> None:
        """Lets the installation read checks and commit statuses (not granted by default)."""
        granted = {"checks": "read", "statuses": "read"}
        self.installations[installation_id].permissions.update(granted)
        # Canvas caches installation tokens (and an unnarrowed one is minted when a project is linked), so
        # apply it to tokens already issued, as if the permission had been there when they were minted.
        for issued in self._tokens.values():
            if issued.installation_id == installation_id:
                issued.permissions.update(granted)

    def delete_branch(self, repo: FakeRepo, branch: str) -> None:
        repo.branches.pop(branch, None)

    def pull(self, repo: FakeRepo, number: int) -> FakePull:
        pull = repo.pulls.get(number)
        if pull is None:
            raise KeyError(f"no pull #{number}")
        return pull

    def open_pulls(self, repo: FakeRepo) -> list[FakePull]:
        return [p for p in repo.pulls.values() if p.state == "open"]

    def calls_to(self, method: str, path_pattern: str) -> list[RecordedRequest]:
        return [r for r in self.requests if r.method == method and re.search(path_pattern, r.path)]

    def clear_records(self) -> None:
        self.requests.clear()
        self.token_requests.clear()

    # ---- HTTP ----------------------------------------------------------------------------------------

    def handle(self, request: httpx.Request) -> httpx.Response:
        raw_path = request.url.raw_path.decode().split("?", 1)[0]
        query = parse_qs(request.url.query.decode())
        method = request.method
        body: Any = None
        if request.content:
            try:
                body = json.loads(request.content)
            except ValueError:
                body = None
        record = RecordedRequest(method, raw_path, "none", body)
        with self._lock:
            self.requests.append(record)
        try:
            if self.latency_ms:
                time.sleep(self.latency_ms / 1000)
            with self._lock:
                if self.fail_with is not None:
                    raise HttpError(self.fail_with[0], "forced failure", dict(self.fail_with[1]))
                result = self._route(method, raw_path, query, body, request.headers.get("authorization"), record)
            if result is None:
                return httpx.Response(204)
            return httpx.Response(201 if method == "POST" else 200, json=result)
        except HttpError as error:
            return httpx.Response(error.status, json={"message": error.message}, headers=error.headers)
        except Exception as error:  # a bug in the fake, not GitHub's answer
            return httpx.Response(500, json={"message": f"fake-github crashed: {error!r}"})

    def _app_auth(self, header: str | None, record: RecordedRequest) -> None:
        token = header[7:] if header and header.startswith("Bearer ") else None
        if not token:
            raise HttpError(401, "A JSON web token could not be decoded")
        try:
            head, payload_part, signature = token.split(".")
            if json.loads(_b64url_decode(head)).get("alg") != "RS256":
                raise ValueError("unexpected algorithm")
            try:
                self.public_key.verify(
                    _b64url_decode(signature), f"{head}.{payload_part}".encode(), padding.PKCS1v15(), hashes.SHA256()
                )
            except InvalidSignature as error:
                raise ValueError("signature verification failed") from error
            payload = json.loads(_b64url_decode(payload_part))
            if payload.get("iss") != self.app_id:
                raise ValueError('unexpected "iss" claim value')
            now = int(time.time())
            iat, exp = payload.get("iat"), payload.get("exp")
            if not isinstance(iat, int) or iat > now:
                raise ValueError(
                    "'Issued at' claim ('iat') must be an Integer representing the time that the assertion was issued"
                )
            if not isinstance(exp, int) or exp - iat > 600:
                raise ValueError("'Expiration time' claim ('exp') is too far in the future")
            if exp <= now:
                raise ValueError('"exp" claim timestamp check failed')
        except (ValueError, KeyError) as error:
            raise HttpError(401, f"Bad credentials: {error}") from error
        record.auth = "app"

    def _installation_auth(self, header: str | None, record: RecordedRequest) -> IssuedToken:
        value = header[6:] if header and header.startswith("token ") else None
        issued = self._tokens.get(value) if value else None
        if issued is None or issued.expires_at < time.time() * 1000 or issued.installation_id not in self.installations:
            raise HttpError(401, "Bad credentials")
        record.auth = "installation"
        return issued

    def _repo_for(self, token: IssuedToken, owner: str, name: str) -> FakeRepo:
        repo = next((r for r in self.repos.values() if r.owner == owner and r.name == name), None)
        return self._assert_repo_access(token, repo)

    def _assert_repo_access(self, token: IssuedToken, repo: FakeRepo | None) -> FakeRepo:
        installation = self.installations.get(token.installation_id)
        if (
            repo is None
            or installation is None
            or repo.id not in installation.repo_ids
            or (token.repo_ids is not None and repo.id not in token.repo_ids)
        ):
            raise HttpError(404, "Not Found")
        return repo

    @staticmethod
    def _need(token: IssuedToken, permission: str, level: str) -> None:
        granted = token.permissions.get(permission)
        ok = granted in ("read", "write") if level == "read" else granted == "write"
        if not ok:
            raise HttpError(403, "Resource not accessible by integration")

    @staticmethod
    def _raw_repo(repo: FakeRepo) -> dict[str, Any]:
        return {
            "id": repo.id,
            "name": repo.name,
            "full_name": f"{repo.owner}/{repo.name}",
            "owner": {"login": repo.owner},
            "default_branch": repo.default_branch,
            "private": repo.private,
        }

    @staticmethod
    def _raw_pull(repo: FakeRepo, pull: FakePull) -> dict[str, Any]:
        return {
            "number": pull.number,
            "html_url": f"https://github.test/{repo.owner}/{repo.name}/pull/{pull.number}",
            "title": pull.title,
            "body": pull.body,
            "state": pull.state,
            "merged": pull.merged,
            "merged_at": pull.merged_at,
            "merged_by": {"login": pull.merged_by} if pull.merged_by else None,
            "merge_commit_sha": pull.merge_commit_sha,
            "closed_at": pull.closed_at,
            "requested_reviewers": [{"login": login} for login in pull.requested_reviewers],
            "requested_teams": [{"slug": slug} for slug in pull.requested_teams],
            "user": {"login": pull.author or "canvas-test[bot]"},
            "head": {
                "sha": repo.branches.get(pull.head, ""),
                "ref": pull.head,
                "repo": {"full_name": pull.head_repo or f"{repo.owner}/{repo.name}"},
            },
            "base": {"ref": pull.base},
        }

    @staticmethod
    def _is_ancestor(repo: FakeRepo, ancestor: str, descendant: str) -> bool:
        seen: set[str] = set()
        stack = [descendant]
        while stack:
            sha = stack.pop()
            if sha == ancestor:
                return True
            if sha in seen:
                continue
            seen.add(sha)
            commit = repo.commits.get(sha)
            stack.extend(commit.parents if commit else [])
        return False

    @staticmethod
    def _raw_installation(i: FakeInstallation) -> dict[str, Any]:
        return {
            "id": i.id,
            "account": {"login": i.account},
            "repository_selection": i.repository_selection,
            "permissions": i.permissions,
        }

    def _route(  # one flat table of GitHub's routes, like the original
        self,
        method: str,
        path: str,
        query: dict[str, list[str]],
        body: Any,
        authorization: str | None,
        record: RecordedRequest,
    ) -> Any:
        b: dict[str, Any] = body if isinstance(body, dict) else {}

        def param(name: str, default: str) -> str:
            return query.get(name, [default])[0]

        # ---- as the App
        if method == "GET" and path == "/app/installations":
            self._app_auth(authorization, record)
            return [self._raw_installation(i) for i in self.installations.values()]
        if method == "GET" and (m := re.fullmatch(r"/app/installations/(\d+)", path)):
            self._app_auth(authorization, record)
            installation = self.installations.get(int(m[1]))
            if installation is None:
                raise HttpError(404, "Not Found")
            return self._raw_installation(installation)
        if (m := re.fullmatch(r"/app/installations/(\d+)/access_tokens", path)) and method == "POST":
            self._app_auth(authorization, record)
            installation = self.installations.get(int(m[1]))
            if installation is None:
                raise HttpError(404, "Not Found")
            self.token_requests.append(TokenRequest(installation.id, b))
            ids = b.get("repository_ids")
            if ids and any(i not in installation.repo_ids for i in ids):
                raise HttpError(
                    422,
                    "There is at least one repository that does not exist or is not accessible to the parent"
                    " installation.",
                )
            requested = b.get("permissions")
            if requested:
                for name, level in requested.items():
                    granted = installation.permissions.get(name)
                    if not granted or (level == "write" and granted != "write"):
                        raise HttpError(
                            422, f"The permissions requested are not granted to this installation ({name})."
                        )
            token = f"ghs_{secrets.token_hex(16)}"
            expires_at = time.time() * 1000 + 60 * 60_000
            self._tokens[token] = IssuedToken(
                installation.id,
                set(ids) if ids else None,
                dict(requested) if requested is not None else dict(installation.permissions),
                expires_at,
            )
            return {"token": token, "expires_at": _iso(expires_at)}

        # ---- as an installation
        token_info = self._installation_auth(authorization, record)

        if method == "GET" and path == "/installation/repositories":
            installation = self.installations[token_info.installation_id]
            repos = [
                self._raw_repo(self.repos[i])
                for i in sorted(installation.repo_ids)
                if token_info.repo_ids is None or i in token_info.repo_ids
            ]
            per_page, page = int(param("per_page", "30")), int(param("page", "1"))
            return {"total_count": len(repos), "repositories": repos[(page - 1) * per_page : page * per_page]}
        if (m := re.fullmatch(r"/repositories/(\d+)", path)) and method == "GET":
            return self._raw_repo(self._assert_repo_access(token_info, self.repos.get(int(m[1]))))

        m = re.fullmatch(r"/repos/([^/]+)/([^/]+)/(.*)", path)
        if not m:
            raise HttpError(404, "Not Found")
        repo = self._repo_for(token_info, unquote(m[1]), unquote(m[2]))
        rest = m[3]

        if method == "GET" and (r := re.fullmatch(r"git/ref/heads/(.+)", rest)):
            self._need(token_info, "contents", "read")
            branch = unquote(r[1])
            sha = repo.branches.get(branch)
            if not sha:
                raise HttpError(404, "Not Found")
            return {"ref": f"refs/heads/{branch}", "object": {"sha": sha, "type": "commit"}}
        if method == "GET" and (r := re.fullmatch(r"git/commits/([0-9a-f]+)", rest)):
            self._need(token_info, "contents", "read")
            commit = repo.commits.get(r[1])
            if commit is None:
                raise HttpError(404, "Not Found")
            return {
                "sha": commit.sha,
                "message": commit.message,
                "tree": {"sha": commit.tree},
                "parents": [{"sha": p} for p in commit.parents],
            }
        # canvas-finl: tree listing and blob reads. A blob's sha is the hash of its content.
        if method == "GET" and (r := re.fullmatch(r"git/trees/([0-9a-f]+)", rest)):
            self._need(token_info, "contents", "read")
            tree_files = repo.trees.get(r[1])
            if tree_files is None:
                raise HttpError(404, "Not Found")
            return {
                "sha": r[1],
                "truncated": False,
                "tree": [
                    {
                        "path": p,
                        "mode": "100644",
                        "type": "blob",
                        "sha": sha1(f"blob|{c}"),
                        "size": len(c.encode("utf-8", "surrogatepass")),
                    }
                    for p, c in tree_files.items()
                ],
            }
        if method == "GET" and (r := re.fullmatch(r"git/blobs/([0-9a-f]+)", rest)):
            self._need(token_info, "contents", "read")
            for tree_files in repo.trees.values():
                for content in tree_files.values():
                    if sha1(f"blob|{content}") == r[1]:
                        encoded = base64.b64encode(content.encode("utf-8", "surrogatepass")).decode()
                        return {"sha": r[1], "encoding": "base64", "content": encoded}
            raise HttpError(404, "Not Found")
        if method == "POST" and rest == "git/trees":
            self._need(token_info, "contents", "write")
            base = repo.trees.get(str(b.get("base_tree")))
            if b.get("base_tree") is not None and base is None:
                raise HttpError(422, "base_tree does not exist")
            tree_files = dict(base or {})
            for entry in b.get("tree") or []:
                if not isinstance(entry.get("content"), str) or entry.get("type") != "blob":
                    raise HttpError(422, "tree entries need type blob and string content")
                tree_files[entry["path"]] = entry["content"]
            sha = tree_sha(tree_files)
            repo.trees[sha] = tree_files
            return {"sha": sha}
        if method == "POST" and rest == "git/commits":
            self._need(token_info, "contents", "write")
            parents = b.get("parents") or []
            if str(b.get("tree")) not in repo.trees or any(p not in repo.commits for p in parents):
                raise HttpError(422, "Tree or parent does not exist")
            commit = FakeCommit(
                sha1(f"{b.get('tree')}|{','.join(parents)}|{b.get('message')}"),
                str(b.get("message")),
                str(b.get("tree")),
                list(parents),
            )
            repo.commits[commit.sha] = commit
            return {"sha": commit.sha}
        if method == "POST" and rest == "git/refs":
            self._need(token_info, "contents", "write")
            name = re.sub(r"^refs/heads/", "", str(b.get("ref")))
            if name in repo.branches:
                raise HttpError(422, "Reference already exists")
            if str(b.get("sha")) not in repo.commits:
                raise HttpError(422, "Object does not exist")
            repo.branches[name] = str(b["sha"])
            return {"ref": f"refs/heads/{name}", "object": {"sha": b["sha"]}}
        if method == "PATCH" and (r := re.fullmatch(r"git/refs/heads/(.+)", rest)):
            self._need(token_info, "contents", "write")
            branch = unquote(r[1])
            if self.before_ref_update:
                self.before_ref_update(repo, branch)
            current = repo.branches.get(branch)
            if not current:
                raise HttpError(422, "Reference does not exist")
            if str(b.get("sha")) not in repo.commits:
                raise HttpError(422, "Object does not exist")
            if b.get("force") is not True and not self._is_ancestor(repo, current, str(b["sha"])):
                raise HttpError(422, "Update is not a fast forward")
            repo.branches[branch] = str(b["sha"])
            return {"ref": f"refs/heads/{branch}", "object": {"sha": b["sha"]}}

        if method == "GET" and rest == "pulls":
            # canvas-3s5.5: listing open pull requests (state + base filters, newest first, paged).
            self._need(token_info, "pull_requests", "read")
            state, base_filter = param("state", "open"), query.get("base", [None])[0]
            per_page, page = int(param("per_page", "30")), int(param("page", "1"))
            matching = sorted(
                (
                    p
                    for p in repo.pulls.values()
                    if (state == "all" or p.state == state) and (not base_filter or p.base == base_filter)
                ),
                key=lambda p: -p.number,
            )
            return [self._raw_pull(repo, p) for p in matching[(page - 1) * per_page : page * per_page]]
        if method == "POST" and rest == "pulls":
            self._need(token_info, "pull_requests", "write")
            head, base_ref = str(b.get("head")), str(b.get("base"))
            if head not in repo.branches or base_ref not in repo.branches:
                raise HttpError(422, "Validation Failed: head or base branch does not exist")
            if any(p.state == "open" and p.head == head and p.base == base_ref for p in repo.pulls.values()):
                raise HttpError(422, "A pull request already exists")
            created = FakePull(repo.next_pull, str(b.get("title")), str(b.get("body") or ""), head, base_ref)
            repo.next_pull += 1
            repo.pulls[created.number] = created
            return self._raw_pull(repo, created)
        if method == "GET" and (r := re.fullmatch(r"pulls/(\d+)/reviews", rest)):
            self._need(token_info, "pull_requests", "read")
            found = repo.pulls.get(int(r[1]))
            if found is None:
                raise HttpError(404, "Not Found")
            per_page, page = int(param("per_page", "30")), int(param("page", "1"))
            return [
                {"user": {"login": rv.login}, "state": rv.state, "submitted_at": _now_iso()}
                for rv in found.reviews[(page - 1) * per_page : page * per_page]
            ]
        if method == "POST" and (r := re.fullmatch(r"issues/(\d+)/comments", rest)):
            self._need(token_info, "pull_requests", "write")
            found = repo.pulls.get(int(r[1]))
            if found is None:
                raise HttpError(404, "Not Found")
            found.comments.append(str(b.get("body")))
            return {"id": len(found.comments), "body": b.get("body")}
        if method == "GET" and (r := re.fullmatch(r"commits/([0-9a-f]+)/check-runs", rest)):
            self._need(token_info, "checks", "read")
            runs = repo.check_runs.get(r[1], [])
            return {
                "total_count": len(runs),
                "check_runs": [{**run, "html_url": f"https://github.test/run/{run['name']}"} for run in runs],
            }
        if method == "GET" and (r := re.fullmatch(r"commits/([0-9a-f]+)/status", rest)):
            self._need(token_info, "statuses", "read")
            statuses = repo.statuses.get(r[1], [])
            return {
                "state": "pending",
                "statuses": [{**st, "target_url": f"https://github.test/status/{st['context']}"} for st in statuses],
            }
        if r := re.fullmatch(r"pulls/(\d+)", rest):
            found = repo.pulls.get(int(r[1]))
            if found is None:
                raise HttpError(404, "Not Found")
            if method == "GET":
                self._need(token_info, "pull_requests", "read")
                return self._raw_pull(repo, found)
            if method == "PATCH":
                self._need(token_info, "pull_requests", "write")
                if isinstance(b.get("title"), str):
                    found.title = b["title"]
                if isinstance(b.get("body"), str):
                    found.body = b["body"]
                if b.get("state") == "closed" and found.state == "open":
                    self.close_pull(repo, found.number)
                return self._raw_pull(repo, found)
        raise HttpError(404, f"fake-github has no route for {method} {path}")
