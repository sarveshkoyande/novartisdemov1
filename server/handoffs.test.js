// node --test handoffs.test.js
const test = require('node:test');
const assert = require('node:assert');
const { evaluate, FIELDS_11_31 } = require('./handoffs');

const allOf = (keys, value = 'x') => Object.fromEntries(keys.map((k) => [k, value]));

test('A fires only after CDM finishes General and confirms Contact Details', () => {
  const cdm = allOf(['10', '11', '12', '13', '14', '15', '16', '17', '18', '20']);
  const v20 = { ...cdm, '20': 'No' };
  assert.ok(!evaluate({ v: allOf(['13', '14', '15', '16']), contactsConfirmed: true }).includes('A'));
  assert.ok(!evaluate({ v: v20 }).includes('A'), 'contacts not confirmed yet');
  assert.ok(evaluate({ v: v20, contactsConfirmed: true }).includes('A'));
});

test('B waits for the Brand code (AE4)', () => {
  const v = allOf(['14', '15', '16', '17', '18', '19', '22', '25', '27']);
  assert.ok(!evaluate({ v }).includes('B'));
  assert.ok(!evaluate({ v, brandCode: '  ' }).includes('B'));
  assert.ok(evaluate({ v, brandCode: 'BR-01' }).includes('B'));
});

test('C only for DTC with an enrolment form (AE5)', () => {
  assert.ok(!evaluate({ v: { '22.1': 'Yes', '18': 'HCP' } }).includes('C'));
  assert.ok(evaluate({ v: { '22.1': 'Yes', '18': 'DTC' } }).includes('C'));
  assert.ok(!evaluate({ v: { '22.1': 'No', '18': 'DTC' } }).includes('C'));
});

test('D ignores hidden fields (AE6)', () => {
  const v = allOf(FIELDS_11_31);
  v['22.1'] = 'No';
  v['20'] = 'No';
  delete v['22.2'];
  delete v['22.3'];
  delete v['20.1'];
  delete v['20.2'];
  assert.ok(evaluate({ v }).includes('D'));
});

test('D waits while a visible sub-field is empty', () => {
  const v = allOf(FIELDS_11_31);
  v['22.1'] = 'Yes';
  v['22.2'] = 'Yes';
  delete v['22.3'];
  assert.ok(!evaluate({ v }).includes('D'));
});

test('E and F need at least one email', () => {
  const v = allOf(['42', '44']);
  assert.ok(!evaluate({ v, emails: [] }).includes('E'));
  assert.ok(!evaluate({ v, emails: [] }).includes('F'));
  assert.ok(evaluate({ v, emails: [{ complete: true, metadataId: null }] }).includes('E'));
  assert.ok(!evaluate({ v, emails: [{ complete: true, metadataId: null }] }).includes('F'));
  assert.ok(evaluate({ v, emails: [{ complete: true, metadataId: 'M-1' }] }).includes('F'));
});
