const request = require('supertest');
const crypto = require('crypto');
const { newDb, DataType } = require('pg-mem');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-production';
process.env.CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
process.env.SEED_PASSWORD = 'Password123';

// ── pg-mem in-memory Postgres, wired in place of config/db ──────────
const inMemoryDb = newDb({ autoCreateForeignKeyIndices: true });
inMemoryDb.public.registerFunction({
  name: 'uuid_generate_v4',
  returns: DataType.uuid,
  implementation: () => crypto.randomUUID(),
  impure: true,
});
const { Pool } = inMemoryDb.adapters.createPg();
const mockPool = new Pool();
jest.mock('../config/db', () => mockPool);

const { createSchema } = require('../config/schema');
const { seedAll } = require('../config/seed');
const { signInviteToken } = require('../middleware/auth');
const app = require('../index');

const PW = 'Password123';
const cookieOf = (res) => res.headers['set-cookie'];

async function login(email) {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status).toBe(200);
  return cookieOf(res);
}

let pm, engineer, field, client, projectId;

beforeAll(async () => {
  await createSchema(mockPool);
  await seedAll(mockPool);
  [pm, engineer, field, client] = await Promise.all([
    login('pm@franmarine.com.au'),
    login('engineer@franmarine.com.au'),
    login('field@franmarine.com.au'),
    login('client@franmarine.com.au'),
  ]);
  const projects = await request(app).get('/api/projects').set('Cookie', pm);
  expect(projects.status).toBe(200);
  projectId = projects.body.projects[0].id;
});

describe('health + auth', () => {
  test('health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('login rejects bad password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'pm@franmarine.com.au', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  test('me returns the seeded role', async () => {
    const res = await request(app).get('/api/auth/me').set('Cookie', engineer);
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('engineer');
    expect(res.body.organisation.name).toBe('Franmarine');
  });

  test('self-registration creates a user attached to the org', async () => {
    const res = await request(app).post('/api/auth/register')
      .send({ email: 'new.field@franmarine.com.au', password: PW, name: 'New Diver', role: 'field' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('field');
  });
});

// The whole lifecycle, run identically for both methods. Only the templates
// (forms / hold points / QA / doc-pack) differ — the lifecycle, gate, event log,
// roles and client view are the same.
describe.each(['weld', 'composite'])('lifecycle: %s', (method) => {
  let workItemId;
  const ref = `P14-${method.toUpperCase()}`;

  test('PM creates a work_item from an RDS (find)', async () => {
    const res = await request(app).post('/api/work-items').set('Cookie', pm).send({
      projectId,
      refCode: ref,
      locationRef: 'Pile P-14, splash zone',
      method,
      notifyEmails: ['Extra@Stakeholder.com', 'extra@stakeholder.com'],
      inspection: { data: { defect_type: 'Corrosion / section loss', member: 'Pile P-14' } },
    });
    expect(res.status).toBe(201);
    expect(res.body.workItem.status).toBe('find');
    // notify list is stored, normalised and de-duplicated
    expect(res.body.workItem.notify_emails).toEqual(['extra@stakeholder.com']);
    workItemId = res.body.workItem.id;

    const card = await request(app).get(`/api/work-items/${workItemId}`).set('Cookie', pm);
    expect(card.body.holdPoints.length).toBeGreaterThan(0);
    expect(card.body.inspection).not.toBeNull();
  });

  test('non-PM cannot create (role enum enforced)', async () => {
    const res = await request(app).post('/api/work-items').set('Cookie', field).send({
      projectId, refCode: `${ref}-X`, method,
    });
    expect(res.status).toBe(403);
  });

  test('fix actions are blocked before the spec is approved (the gate)', async () => {
    const card = await request(app).get(`/api/work-items/${workItemId}`).set('Cookie', field);
    const hp = card.body.holdPoints[0];
    const sign = await request(app).post(`/api/work-items/${workItemId}/hold-points/${hp.id}/sign`).set('Cookie', field);
    expect(sign.status).toBe(409);
    expect(sign.body.error).toBe('gate_blocked');

    const qa = await request(app).post(`/api/work-items/${workItemId}/qa`).set('Cookie', field).send({ data: { x: 1 } });
    expect(qa.status).toBe(409);
  });

  test('engineer submits a spec (-> engineer)', async () => {
    const res = await request(app).post(`/api/work-items/${workItemId}/spec`).set('Cookie', engineer)
      .send({ notes: 'Doubler plate per drawing D-14.' });
    expect(res.status).toBe(201);
    const card = await request(app).get(`/api/work-items/${workItemId}`).set('Cookie', pm);
    expect(card.body.workItem.status).toBe('engineer');
  });

  test('engineer approves the spec (the gate opens -> fix)', async () => {
    const card = await request(app).get(`/api/work-items/${workItemId}`).set('Cookie', engineer);
    const specId = card.body.specs.find((s) => s.status === 'draft').id;
    const res = await request(app).post(`/api/work-items/${workItemId}/spec/${specId}/approve`).set('Cookie', engineer);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('fix');
  });

  test('field signs every ITP hold point (fix actions now allowed)', async () => {
    const card = await request(app).get(`/api/work-items/${workItemId}`).set('Cookie', field);
    for (const hp of card.body.holdPoints) {
      const res = await request(app).post(`/api/work-items/${workItemId}/hold-points/${hp.id}/sign`).set('Cookie', field);
      expect(res.status).toBe(200);
    }
  });

  test('media upload computes sha256 + exif at capture', async () => {
    const res = await request(app).post(`/api/work-items/${workItemId}/media`).set('Cookie', field)
      .attach('file', Buffer.from('%PDF-1.4 fake spec doc'), { filename: 'evidence.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    expect(res.body.media.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.media.exif).toEqual({});
    expect(res.body.media.url).toContain('/media/');

    // bytes are retrievable
    const get = await request(app).get(res.body.media.url).set('Cookie', client);
    expect(get.status).toBe(200);
  });

  test('QA capture (-> verify) then client sign-off', async () => {
    const qa = await request(app).post(`/api/work-items/${workItemId}/qa`).set('Cookie', field)
      .send({ data: { ndt_result: 'Acceptable', qa_notes: 'Within tolerance.' } });
    expect(qa.status).toBe(201);
    expect(qa.body.status).toBe('verify');
    const qaId = qa.body.qa.id;

    // client is read-only for actions other than their sign-off
    const cannotCreate = await request(app).post('/api/work-items').set('Cookie', client)
      .send({ projectId, refCode: 'X', method });
    expect(cannotCreate.status).toBe(403);

    const sign = await request(app).post(`/api/work-items/${workItemId}/qa/${qaId}/client-sign`).set('Cookie', client);
    expect(sign.status).toBe(200);
  });

  test('doc pack exports as a PDF', async () => {
    const res = await request(app).get(`/api/work-items/${workItemId}/docpack`).set('Cookie', client).buffer();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  test('PM closes the work_item (-> closed)', async () => {
    const res = await request(app).post(`/api/work-items/${workItemId}/close`).set('Cookie', pm);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('closed');
  });

  test('every action is in the event log with actor + timestamp', async () => {
    const res = await request(app).get(`/api/work-items/${workItemId}/events`).set('Cookie', client);
    expect(res.status).toBe(200);
    const types = res.body.events.map((e) => e.type);
    for (const expected of [
      'work_item.created', 'inspection.captured',
      'spec.submitted', 'spec.approved',
      'hold_point.signed', 'qa.captured', 'qa.client_signed',
      'media.uploaded', 'work_item.closed',
      'work_item.status_changed',
    ]) {
      expect(types).toContain(expected);
    }
    // actor + timestamp on every row
    for (const e of res.body.events) {
      expect(e.actor_id).toBeTruthy();
      expect(e.actor_name).toBeTruthy();
      expect(e.created_at).toBeTruthy();
    }
  });
});

describe('invite / claim flow', () => {
  let wiId;
  beforeAll(async () => {
    const res = await request(app).post('/api/work-items').set('Cookie', pm).send({
      projectId, refCode: 'INVITE-01', method: 'weld',
    });
    wiId = res.body.workItem.id;
  });

  test('invite-view returns the card for a valid token without a session', async () => {
    const token = signInviteToken({ email: 'NewEng@ext.com', role: 'engineer', workItemId: wiId });
    const res = await request(app).get(`/api/work-items/${wiId}/invite-view?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.body.workItem.id).toBe(wiId);
    expect(res.body.invite).toEqual(expect.objectContaining({ role: 'engineer', exists: false }));
  });

  test('invite-view rejects an invalid token', async () => {
    const res = await request(app).get(`/api/work-items/${wiId}/invite-view?token=garbage`);
    expect(res.status).toBe(401);
  });

  test('claim creates a new account with the invite role and can act', async () => {
    const token = signInviteToken({ email: 'neweng@ext.com', role: 'engineer', workItemId: wiId });
    const res = await request(app).post('/api/auth/claim-invite').send({ token, password: 'Password123' });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.user.role).toBe('engineer');
    expect(res.body.user.email).toBe('neweng@ext.com');
    // the freshly-created engineer can perform their step
    const spec = await request(app).post(`/api/work-items/${wiId}/spec`).set('Cookie', res.headers['set-cookie']).send({ notes: 'via invite' });
    expect(spec.status).toBe(201);
  });

  test('claim for an existing email verifies password and keeps its own role', async () => {
    const token = signInviteToken({ email: 'pm@franmarine.com.au', role: 'client', workItemId: wiId });
    const bad = await request(app).post('/api/auth/claim-invite').send({ token, password: 'wrongpass' });
    expect(bad.status).toBe(401);
    const good = await request(app).post('/api/auth/claim-invite').send({ token, password: PW });
    expect(good.status).toBe(200);
    expect(good.body.created).toBe(false);
    expect(good.body.user.role).toBe('admin_pm');
  });
});

describe('method selects templates only', () => {
  test('weld and composite expose different template sets', async () => {
    const weld = await request(app).get('/api/templates?method=weld&kind=itp').set('Cookie', pm);
    const comp = await request(app).get('/api/templates?method=composite&kind=itp').set('Cookie', pm);
    expect(weld.status).toBe(200);
    expect(comp.status).toBe(200);
    const weldLabels = weld.body.templates[0].definition.holdPoints.map((h) => h.label);
    const compLabels = comp.body.templates[0].definition.holdPoints.map((h) => h.label);
    expect(weldLabels).not.toEqual(compLabels);
  });
});
