"""canvas-vvi: live co-editing's change format, as diagram-core's src/live/model-patch.ts applies it.

A patch is one person's change, element by element. The live hub applies each patch it receives to the room's
model in arrival order, and every browser applies the same patches in the same order, so all end on the same
model. `apply_patch` must give TypeScript's answer exactly (tests/test_live_patch.py replays TypeScript-made
vectors). `patch_problem` is the server's own check of a patch's shape, before anything is applied.
"""

from __future__ import annotations

from typing import Any

COLLECTIONS = ("nodes", "edges", "containers")
_COLLECTION_KEYS = frozenset(COLLECTIONS)
_PATCH_KEYS = frozenset({"set", "unset", *COLLECTIONS})
_COLLECTION_PATCH_KEYS = frozenset({"added", "removed", "changed", "order"})
_CHANGE_KEYS = frozenset({"id", "set", "unset"})
#: A model's own type: never changed live (it decides the family the room parses with).
_FIXED_FIELDS = frozenset({"diagramTypeId"})
#: Most elements one patch may name in a collection list.
MAX_ITEMS = 5000
#: Longest id or field name.
MAX_KEY_LENGTH = 200


def _with_fields(value: dict[str, Any], set_: dict[str, Any] | None, unset: list[str] | None) -> dict[str, Any]:
    result = dict(value)
    result.update(set_ or {})
    for key in unset or []:
        result.pop(key, None)
    return result


def _reordered(elements: list[dict[str, Any]], order: list[str]) -> list[dict[str, Any]]:
    """The elements `order` names take the places those elements already hold, in `order`'s order."""
    rank: dict[str, int] = {}
    for element_id in order:
        rank.setdefault(element_id, len(rank))
    places = [i for i, element in enumerate(elements) if element.get("id") in rank]
    moving = sorted((elements[i] for i in places), key=lambda element: rank[element["id"]])
    result = list(elements)
    for place, element in zip(places, moving, strict=True):
        result[place] = element
    return result


def _apply_collection(elements: list[dict[str, Any]], patch: dict[str, Any]) -> list[dict[str, Any]]:
    removed = set(patch.get("removed") or [])
    result = [element for element in elements if element.get("id") not in removed] if removed else list(elements)
    for change in patch.get("changed") or []:
        index = next((i for i, element in enumerate(result) if element.get("id") == change["id"]), -1)
        # A change to something already deleted is dropped: the delete wins.
        if index >= 0:
            unset = [key for key in change.get("unset") or [] if key != "id"]
            result[index] = _with_fields(result[index], change.get("set"), unset)
    for element in patch.get("added") or []:
        index = next((i for i, existing in enumerate(result) if existing.get("id") == element["id"]), -1)
        if index >= 0:
            result[index] = element
        else:
            result.append(element)
    if patch.get("order"):
        result = _reordered(result, patch["order"])
    return result


def apply_patch(model: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """`model` with `patch` applied; `model` itself is left as it was."""
    unset = [key for key in patch.get("unset") or [] if key not in _COLLECTION_KEYS]
    result = _with_fields(model, patch.get("set"), unset)
    for collection in COLLECTIONS:
        elements = model.get(collection) or []
        change = patch.get(collection)
        result[collection] = _apply_collection(elements, change) if change else list(elements)
    return result


def _key_problem(key: Any, what: str) -> str | None:
    if not isinstance(key, str) or not key or len(key) > MAX_KEY_LENGTH:
        return f"{what} must be a non-empty string of at most {MAX_KEY_LENGTH} characters"
    return None


def _keys_problem(keys: Any, what: str, forbidden: frozenset[str] = frozenset()) -> str | None:
    if not isinstance(keys, list) or len(keys) > MAX_ITEMS:
        return f"{what} must be a list of at most {MAX_ITEMS} names"
    for key in keys:
        if problem := _key_problem(key, what):
            return problem
        if key in forbidden:
            return f"{what} may not name {key}"
    return None


def _fields_problem(fields: Any, what: str, forbidden: frozenset[str]) -> str | None:
    if not isinstance(fields, dict):
        return f"{what} must be an object"
    return _keys_problem(list(fields), what, forbidden)


def _element_problem(element: Any, what: str) -> str | None:
    if not isinstance(element, dict):
        return f"{what} must hold objects"
    return _key_problem(element.get("id"), f"{what} id")


def _collection_problem(patch: Any, collection: str) -> str | None:
    if not isinstance(patch, dict) or not set(patch) <= _COLLECTION_PATCH_KEYS:
        return f"{collection} must be an object with added, removed, changed or order"
    added = patch.get("added", [])
    if not isinstance(added, list) or len(added) > MAX_ITEMS:
        return f"{collection}.added must be a list of at most {MAX_ITEMS} elements"
    for element in added:
        if problem := _element_problem(element, f"{collection}.added"):
            return problem
    for key in ("removed", "order"):
        if key in patch and (problem := _keys_problem(patch[key], f"{collection}.{key}")):
            return problem
    changed = patch.get("changed", [])
    if not isinstance(changed, list) or len(changed) > MAX_ITEMS:
        return f"{collection}.changed must be a list of at most {MAX_ITEMS} changes"
    for change in changed:
        if not isinstance(change, dict) or not set(change) <= _CHANGE_KEYS:
            return f"{collection}.changed must hold objects with id, set and unset"
        if problem := _key_problem(change.get("id"), f"{collection}.changed id"):
            return problem
        id_only = frozenset({"id"})
        if "set" in change and (problem := _fields_problem(change["set"], f"{collection}.changed set", id_only)):
            return problem
        if "unset" in change and (problem := _keys_problem(change["unset"], f"{collection}.changed unset", id_only)):
            return problem
    return None


def patch_problem(patch: Any) -> str | None:
    """Why `patch` isn't a patch the hub will apply, or None. Checks its shape only: whether the patched model
    still makes a diagram is the hub's round trip."""
    if not isinstance(patch, dict) or not set(patch) <= _PATCH_KEYS:
        return "A patch is an object with set, unset, nodes, edges or containers"
    top_forbidden = _COLLECTION_KEYS | _FIXED_FIELDS
    if "set" in patch and (problem := _fields_problem(patch["set"], "set", top_forbidden)):
        return problem
    if "unset" in patch and (problem := _keys_problem(patch["unset"], "unset", top_forbidden)):
        return problem
    for collection in COLLECTIONS:
        if collection in patch and (problem := _collection_problem(patch[collection], collection)):
            return problem
    return None


__all__ = ["COLLECTIONS", "apply_patch", "patch_problem"]
