import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/client.js';
import { purgeDiagrams } from '../../src/diagrams/diagram.service.js';
import { buildTestApp, closeTestDb, resetDatabase, seedFlowchartDiagramType, seedUser } from '../helpers/setup.js';

/** canvas-bw4: comments on diagrams -- threads, replies, pins, resolve, unread, and who may do what. */

type Who = 'owner' | 'admin' | 'viewer' | 'commenter' | 'editor' | 'stranger';
interface Comment {
  id: string;
  threadRootId: string | null;
  author: { id: string; name: string };
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}
interface Thread extends Comment {
  anchor: { type: 'node' | 'edge'; id: string } | null;
  resolved: { at: string; by: string | null } | null;
  replies: Comment[];
}

describe('Diagram comments (canvas-bw4)', () => {
  let app: FastifyInstance;
  const ids = {} as Record<Who, string>;
  const cookies = {} as Record<Who, string>;
  let diagramId = '';
  let projectId = '';

  async function loginCookie(email: string, password: string) {
    const res = await app.inject({ method: 'POST', url: '/auth/local/login', payload: { email, password } });
    return String(res.headers['set-cookie']).split(';')[0];
  }
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, who?: Who, payload?: unknown) =>
    app.inject({ method, url, headers: who ? { cookie: cookies[who] } : {}, payload: payload as object });
  const base = () => `/diagrams/${diagramId}/comments`;
  const threads = async (who: Who = 'owner') => (await call('GET', base(), who)).json().threads as Thread[];
  const post = async (who: Who, body: string, extra: Record<string, unknown> = {}) => {
    const res = await call('POST', base(), who, { body, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };

  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetDatabase();
    await seedFlowchartDiagramType();
    const users: [Who, string, 'admin' | 'architect'][] = [
      ['owner', 'Olivia Owner', 'architect'],
      ['admin', 'Adam Admin', 'admin'],
      ['viewer', 'Vera Viewer', 'architect'],
      ['commenter', 'Cody Commenter', 'architect'],
      ['editor', 'Edie Editor', 'architect'],
      ['stranger', 'Sam Stranger', 'architect'],
    ];
    for (const [who, name, role] of users) {
      ids[who] = (await seedUser({ email: `${who}@example.com`, name, password: `${who}-pass`, role })).id; // gitleaks:allow
      cookies[who] = await loginCookie(`${who}@example.com`, `${who}-pass`); // gitleaks:allow
    }
    projectId = (await call('POST', '/projects', 'owner', { name: 'Comment project' })).json().project.id;
    diagramId = (await call('POST', `/projects/${projectId}/diagrams`, 'owner', { name: 'Commented', diagramTypeId: 'flowchart' })).json().diagram.id;
    for (const [who, level] of [['viewer', 'view'], ['commenter', 'comment'], ['editor', 'edit']] as const) {
      expect((await call('POST', `/diagrams/${diagramId}/shares`, 'owner', { granteeUserId: ids[who], accessLevel: level })).statusCode).toBe(201);
    }
  });

  describe('threads, replies and the list shape', () => {
    it('posts a thread and replies; the list is oldest first, nested, with author names', async () => {
      const first = await post('owner', 'First thread');
      const reply1 = await post('commenter', 'A reply', { threadRootId: first });
      const second = await post('editor', 'Second thread');
      const reply2 = await post('owner', 'Another reply', { threadRootId: first });

      const list = await threads();
      expect(list.map((t) => t.id)).toEqual([first, second]);
      expect(list[0]).toMatchObject({ body: 'First thread', author: { id: ids.owner, name: 'Olivia Owner' }, threadRootId: null, anchor: null, resolved: null, deleted: false, editedAt: null });
      expect(list[0].replies.map((r) => r.id)).toEqual([reply1, reply2]);
      expect(list[0].replies[0]).toMatchObject({ body: 'A reply', author: { name: 'Cody Commenter' }, threadRootId: first });
      expect(list[1].replies).toEqual([]);
      expect(new Date(list[0].createdAt).getTime()).toBeLessThanOrEqual(new Date(list[1].createdAt).getTime());
    });

    it('pins a thread to a node or an edge, and never pins replies', async () => {
      const onNode = await post('owner', 'About a node', { anchor: { type: 'node', id: 'n1' } });
      const onEdge = await post('owner', 'About an edge', { anchor: { type: 'edge', id: 'e1' } });
      const reply = await post('commenter', 'Reply with a stray anchor', { threadRootId: onNode, anchor: { type: 'edge', id: 'e9' } });
      const list = await threads();
      expect(list.find((t) => t.id === onNode)!.anchor).toEqual({ type: 'node', id: 'n1' });
      expect(list.find((t) => t.id === onEdge)!.anchor).toEqual({ type: 'edge', id: 'e1' });
      const stored = await getDb().selectFrom('diagram_comments').select(['anchor_type', 'anchor_id']).where('id', '=', reply).executeTakeFirstOrThrow();
      expect(stored).toEqual({ anchor_type: null, anchor_id: null });
    });

    it('rejects an invalid anchor type with 400', async () => {
      expect((await call('POST', base(), 'owner', { body: 'x', anchor: { type: 'diagram', id: 'n1' } })).statusCode).toBe(400);
    });

    it('trims the body', async () => {
      await post('owner', '  padded  ');
      expect((await threads())[0].body).toBe('padded');
    });

    it('replying to a reply, or to another diagram\'s thread, is 404', async () => {
      const root = await post('owner', 'Root');
      const reply = await post('owner', 'Reply', { threadRootId: root });
      expect((await call('POST', base(), 'owner', { body: 'nested', threadRootId: reply })).statusCode).toBe(404);

      const other = (await call('POST', `/projects/${projectId}/diagrams`, 'owner', { name: 'Other', diagramTypeId: 'flowchart' })).json().diagram.id as string;
      const otherThread = (await call('POST', `/diagrams/${other}/comments`, 'owner', { body: 'elsewhere' })).json().id as string;
      expect((await call('POST', base(), 'owner', { body: 'cross', threadRootId: otherThread })).statusCode).toBe(404);
      expect((await call('POST', base(), 'owner', { body: 'ghost', threadRootId: randomUUID() })).statusCode).toBe(404);
    });

    it('empty, whitespace-only and over-long bodies are 400; exactly 4000 characters is fine', async () => {
      for (const body of ['', '   \n  ', 'x'.repeat(4001)]) {
        expect((await call('POST', base(), 'owner', { body })).statusCode, body.length.toString()).toBe(400);
      }
      expect((await call('POST', base(), 'owner', { body: 'x'.repeat(4000) })).statusCode).toBe(201);
      expect((await call('POST', base(), 'owner', {})).statusCode).toBe(400);
    });
  });

  describe('who may do what', () => {
    it('a view-only user can read but not post, reply, edit or resolve', async () => {
      const root = await post('owner', 'Root');
      expect((await call('GET', base(), 'viewer')).statusCode).toBe(200);
      expect((await call('GET', `${base()}/unread`, 'viewer')).statusCode).toBe(200);
      expect((await call('POST', base(), 'viewer', { body: 'nope' })).statusCode).toBe(403);
      expect((await call('POST', base(), 'viewer', { body: 'nope', threadRootId: root })).statusCode).toBe(403);
      expect((await call('POST', `${base()}/${root}/resolve`, 'viewer')).statusCode).toBe(403);
      expect((await call('POST', `${base()}/${root}/reopen`, 'viewer')).statusCode).toBe(403);
      expect((await call('PATCH', `${base()}/${root}`, 'viewer', { body: 'edit' })).statusCode).toBe(403);
    });

    it('comment and edit level users can post, reply and resolve', async () => {
      for (const who of ['commenter', 'editor'] as const) {
        const root = await post(who, `Root by ${who}`);
        await post(who, 'Reply', { threadRootId: root });
        expect((await call('POST', `${base()}/${root}/resolve`, who)).statusCode).toBe(200);
      }
    });

    it('the owner and an admin can post', async () => {
      await post('owner', 'Owner');
      await post('admin', 'Admin');
      expect(await threads()).toHaveLength(2);
    });

    it('a user with no access gets 403 on every route', async () => {
      const root = await post('owner', 'Root');
      expect((await call('GET', base(), 'stranger')).statusCode).toBe(403);
      expect((await call('GET', `${base()}/unread`, 'stranger')).statusCode).toBe(403);
      expect((await call('POST', `${base()}/read`, 'stranger')).statusCode).toBe(403);
      expect((await call('POST', base(), 'stranger', { body: 'x' })).statusCode).toBe(403);
      expect((await call('PATCH', `${base()}/${root}`, 'stranger', { body: 'x' })).statusCode).toBe(403);
      expect((await call('DELETE', `${base()}/${root}`, 'stranger')).statusCode).toBe(403);
      expect((await call('POST', `${base()}/${root}/resolve`, 'stranger')).statusCode).toBe(403);
    });

    it('unauthenticated requests are 401', async () => {
      const root = await post('owner', 'Root');
      expect((await call('GET', base())).statusCode).toBe(401);
      expect((await call('POST', base(), undefined, { body: 'x' })).statusCode).toBe(401);
      expect((await call('DELETE', `${base()}/${root}`)).statusCode).toBe(401);
    });
  });

  describe('editing', () => {
    it('the author can edit and editedAt is set; a non-author cannot, even the owner', async () => {
      const id = await post('commenter', 'Original');
      const edited = await call('PATCH', `${base()}/${id}`, 'commenter', { body: ' Changed ' });
      expect(edited.statusCode).toBe(200);
      const t = (edited.json().threads as Thread[])[0];
      expect(t).toMatchObject({ body: 'Changed' });
      expect(t.editedAt).not.toBeNull();

      expect((await call('PATCH', `${base()}/${id}`, 'owner', { body: 'Hijack' })).statusCode).toBe(403);
      expect((await call('PATCH', `${base()}/${id}`, 'editor', { body: 'Hijack' })).statusCode).toBe(403);
      expect((await threads())[0].body).toBe('Changed');
    });

    it('an edit validates the body, and a deleted or unknown comment is 404', async () => {
      const id = await post('commenter', 'Original');
      expect((await call('PATCH', `${base()}/${id}`, 'commenter', { body: '  ' })).statusCode).toBe(400);
      expect((await call('PATCH', `${base()}/${randomUUID()}`, 'commenter', { body: 'x' })).statusCode).toBe(404);
      await call('DELETE', `${base()}/${id}`, 'commenter');
      expect((await call('PATCH', `${base()}/${id}`, 'commenter', { body: 'x' })).statusCode).toBe(404);
    });
  });

  describe('deleting', () => {
    it('the author, the diagram owner and an admin can delete; a comment-level non-author cannot', async () => {
      const mine = await post('commenter', 'By commenter');
      const others = await post('editor', 'By editor');
      await post('owner', 'Keeps the thread list non-empty');

      expect((await call('DELETE', `${base()}/${others}`, 'commenter')).statusCode).toBe(403);
      expect((await call('DELETE', `${base()}/${others}`, 'viewer')).statusCode).toBe(403);
      expect((await call('DELETE', `${base()}/${mine}`, 'commenter')).statusCode).toBe(200);
      expect((await call('DELETE', `${base()}/${others}`, 'owner')).statusCode).toBe(200);

      const third = await post('commenter', 'Another');
      expect((await call('DELETE', `${base()}/${third}`, 'admin')).statusCode).toBe(200);
    });

    it('a deleted reply shows deleted:true with an empty body, and the thread still reads', async () => {
      const root = await post('owner', 'Root');
      const reply = await post('commenter', 'Secret words', { threadRootId: root });
      await call('DELETE', `${base()}/${reply}`, 'commenter');
      const t = (await threads())[0];
      expect(t.replies).toHaveLength(1);
      expect(t.replies[0]).toMatchObject({ id: reply, deleted: true, body: '' });
      const stored = await getDb().selectFrom('diagram_comments').select('body').where('id', '=', reply).executeTakeFirstOrThrow();
      expect(stored.body).toBe('');
    });

    it('a deleted root with live replies still shows; a thread with everything deleted disappears', async () => {
      const root = await post('owner', 'Root');
      const reply = await post('commenter', 'Reply', { threadRootId: root });
      await call('DELETE', `${base()}/${root}`, 'owner');
      let list = await threads();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ deleted: true, body: '' });
      expect(list[0].replies[0].body).toBe('Reply');

      await call('DELETE', `${base()}/${reply}`, 'commenter');
      list = await threads();
      expect(list).toHaveLength(0);
    });

    it('deleting twice, or an unknown comment, is 404', async () => {
      const id = await post('owner', 'x');
      expect((await call('DELETE', `${base()}/${id}`, 'owner')).statusCode).toBe(200);
      expect((await call('DELETE', `${base()}/${id}`, 'owner')).statusCode).toBe(404);
      expect((await call('DELETE', `${base()}/${randomUUID()}`, 'owner')).statusCode).toBe(404);
    });
  });

  describe('resolve and reopen', () => {
    it('resolves a thread (root only) with who resolved it, and reopens it', async () => {
      const root = await post('owner', 'Root');
      const reply = await post('commenter', 'Reply', { threadRootId: root });

      const resolved = await call('POST', `${base()}/${root}/resolve`, 'editor');
      expect(resolved.statusCode).toBe(200);
      const t = (resolved.json().threads as Thread[])[0];
      expect(t.resolved).toMatchObject({ by: 'Edie Editor' });
      expect(new Date(t.resolved!.at).getTime()).toBeGreaterThan(0);

      const reopened = await call('POST', `${base()}/${root}/reopen`, 'commenter');
      expect(reopened.statusCode).toBe(200);
      expect((reopened.json().threads as Thread[])[0].resolved).toBeNull();

      expect((await call('POST', `${base()}/${reply}/resolve`, 'owner')).statusCode).toBe(400);
      expect((await call('POST', `${base()}/${reply}/reopen`, 'owner')).statusCode).toBe(400);
      expect((await call('POST', `${base()}/${randomUUID()}/resolve`, 'owner')).statusCode).toBe(404);
    });

    it('a thread whose root was deleted can still be resolved', async () => {
      const root = await post('owner', 'Root');
      await post('commenter', 'Reply', { threadRootId: root });
      await call('DELETE', `${base()}/${root}`, 'owner');
      expect((await call('POST', `${base()}/${root}/resolve`, 'owner')).statusCode).toBe(200);
    });
  });

  describe('unread', () => {
    const unread = async (who: Who) => (await call('GET', `${base()}/unread`, who)).json().unread as number;

    it('counts others\' comments since the last read, never your own or deleted ones', async () => {
      expect(await unread('owner')).toBe(0);
      await post('commenter', 'One');
      const two = await post('editor', 'Two');
      expect(await unread('owner')).toBe(2);
      expect((await call('GET', base(), 'owner')).json().unread).toBe(2);
      await post('owner', 'My own'); // posting marks everything read, so check the others first
      expect(await unread('commenter')).toBe(2); // the editor's and the owner's, not their own
      await call('DELETE', `${base()}/${two}`, 'editor');
      expect(await unread('commenter')).toBe(1); // only the owner's comment is left to read
    });

    it('reading resets it, new comments count again, and posting marks everything read', async () => {
      await post('commenter', 'One');
      expect(await unread('owner')).toBe(1);
      expect((await call('POST', `${base()}/read`, 'owner')).statusCode).toBe(204);
      expect(await unread('owner')).toBe(0);

      await post('commenter', 'Two');
      expect(await unread('owner')).toBe(1);
      await post('owner', 'Replying marks it all read');
      expect(await unread('owner')).toBe(0);
    });

    it('is tracked per user', async () => {
      await post('commenter', 'One');
      await call('POST', `${base()}/read`, 'owner');
      expect(await unread('owner')).toBe(0);
      expect(await unread('viewer')).toBe(1);
    });
  });

  describe('deleted diagrams and authors', () => {
    it('a soft-deleted diagram is 404 on every comment route', async () => {
      const root = await post('owner', 'Root');
      expect((await call('DELETE', `/diagrams/${diagramId}`, 'owner')).statusCode).toBeLessThan(300);
      expect((await call('GET', base(), 'owner')).statusCode).toBe(404);
      expect((await call('GET', `${base()}/unread`, 'owner')).statusCode).toBe(404);
      expect((await call('POST', `${base()}/read`, 'owner')).statusCode).toBe(404);
      expect((await call('POST', base(), 'owner', { body: 'x' })).statusCode).toBe(404);
      expect((await call('PATCH', `${base()}/${root}`, 'owner', { body: 'x' })).statusCode).toBe(404);
      expect((await call('DELETE', `${base()}/${root}`, 'owner')).statusCode).toBe(404);
      expect((await call('POST', `${base()}/${root}/resolve`, 'owner')).statusCode).toBe(404);
      expect((await call('POST', `${base()}/${root}/reopen`, 'owner')).statusCode).toBe(404);
    });

    it('purging a diagram removes its comments and read markers', async () => {
      await post('commenter', 'Root');
      await call('POST', `${base()}/read`, 'owner');
      const db = getDb();
      expect(await db.selectFrom('diagram_comments').select('id').execute()).toHaveLength(1);
      expect(await db.selectFrom('diagram_comment_reads').select('user_id').execute()).toHaveLength(2); // commenter (posting) and owner
      await purgeDiagrams([diagramId]);
      expect(await db.selectFrom('diagram_comments').select('id').execute()).toHaveLength(0);
      expect(await db.selectFrom('diagram_comment_reads').select('user_id').execute()).toHaveLength(0);
    });

    it('a deleted (anonymised) author shows as "Deleted user"', async () => {
      await post('commenter', 'Written before leaving');
      expect((await call('DELETE', `/admin/users/${ids.commenter}`, 'admin')).statusCode).toBe(200);
      const t = (await threads())[0];
      expect(t.author.name).toBe('Deleted user');
      expect(t.body).toBe('Written before leaving');
    });
  });
});
