import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHtml,
  safeFootnoteUrl,
} from '../../src/cv/generate-cover-letter.mjs';

const payload = url => ({
  candidate: { name: 'Candidate' },
  letter: {
    role_title: 'Role',
    opening: 'Opening',
    profile_intro: 'Profile',
    footnotes: [{ marker: '1', text: 'Source', url }],
  },
});

test('cover-letter footnotes allow only uncredentialed HTTPS URLs', () => {
  assert.equal(safeFootnoteUrl('https://example.com/path'), 'https://example.com/path');
  for (const value of [
    'http://example.com',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'https://user:password@example.com',
  ]) {
    assert.equal(safeFootnoteUrl(value), '', value);
    assert.doesNotMatch(buildHtml(payload(value)), /href="(?:javascript|data|file|http):/i);
  }
});
