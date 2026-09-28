import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute } from '../fixtures/fake-opencode.mjs';

test('fake router prefers static routes over parameter routes', () => {
  const status = () => 'status';
  const session = () => 'session';
  const routes = { 'GET /session/:id': session, 'GET /session/status': status };
  assert.equal(matchRoute(routes, 'GET', '/session/status').handler, status);
  assert.equal(matchRoute(routes, 'GET', '/session/ses_x').handler, session);
});

test('fake router prefers the parameter route with more static segments', () => {
  const broad = () => 'broad';
  const specific = () => 'specific';
  const routes = { 'GET /session/:id/:action': broad, 'GET /session/:id/diff': specific };
  assert.equal(matchRoute(routes, 'GET', '/session/ses_x/diff').handler, specific);
});
