import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { validatePublishedChatEndpoint } from '../check-endpoint-literals.mjs';

test('生产端点清单的群聊地址不能漏发或携带凭据', () => {
  for (const file of ['endpoint.json', 'endpoint.global.json']) {
    const manifest = JSON.parse(fs.readFileSync(new URL(`../../config/${file}`, import.meta.url), 'utf8'));
    assert.doesNotThrow(() => validatePublishedChatEndpoint(manifest));
    const missing = { ...manifest }; delete missing.chatApiBaseUrl;
    assert.throws(() => validatePublishedChatEndpoint(missing), /chatApiBaseUrl/);
  }
  for (const url of ['', 'http://chat.example.invalid', 'https://secret@chat.example.invalid', 'https://chat.example.invalid?key=secret']) {
    assert.throws(() => validatePublishedChatEndpoint({ chatApiBaseUrl: url }), /chatApiBaseUrl/);
  }
});

test('dev endpoint 模板保留 Telegram 字段但默认不启用', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../../config/endpoint.dev.json.example', import.meta.url), 'utf8'),
  );

  assert.equal(manifest.telegramHookWsUrl, '');
});
