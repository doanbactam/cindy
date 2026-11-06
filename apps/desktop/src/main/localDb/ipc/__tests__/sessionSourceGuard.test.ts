import { describe, expect, it } from 'vitest';

import { assertRendererSessionSourceAllowed } from '../sessionSourceGuard';

describe('assertRendererSessionSourceAllowed', () => {
  it('lets ordinary creates through without a source', () => {
    expect(() => assertRendererSessionSourceAllowed({ source: undefined })).not.toThrow();
  });

  it('rejects every renderer-requested source, including the removed Cindy Make purposes', () => {
    for (const source of ['cindy-make', 'cindy-make-merge', 'bot', 'desktop', null]) {
      expect(() => assertRendererSessionSourceAllowed({ source })).toThrow(/\[UNSUPPORTED_CAPABILITY\]/);
    }
  });
});
