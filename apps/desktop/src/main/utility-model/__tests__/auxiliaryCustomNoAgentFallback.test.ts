import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../');

describe('custom auxiliary chain does not hit the session agent', () => {
  it('Help only allows the session oneShot fallback for the automatic chain', () => {
    const source = readFileSync(path.join(root, 'maker-ipc/help.ts'), 'utf8');
    expect(source.match(/const auxiliaryChain = getEffectiveAuxiliaryModelChain\(\);/g)?.length).toBe(2);
    expect(source.match(/auxiliaryChain\.source === 'auto'/g)?.length).toBe(2);
    expect(source).not.toContain('isAuxiliaryModelCustomized');
    expect(source.match(/maker\.oneShot/g)?.length).toBeGreaterThan(0);
    expect(source).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(source.match(/beforeDispatch: async \(\) => isHelpOwnerScopeCurrent\(ownerScopeKey, auxiliaryChainSnapshot\)/g)?.length).toBe(2);
    expect(source.match(/beforeDispatch: beforeSessionAgentDispatch/g)?.length).toBe(2);
    expect(source).toContain('isHelpSessionAgentDispatchAllowed');
  });

  it('pinned-card summaries skip agent oneShot when the auxiliary list is customized', () => {
    const source = readFileSync(path.join(root, 'sessionTaskSummary.ts'), 'utf8');
    expect(source).toContain('const auxiliaryChain = getEffectiveAuxiliaryModelChain();');
    expect(source).toContain("auxiliaryChain.source !== 'auto' ||");
    expect(source).not.toContain('isAuxiliaryModelCustomized');
    expect(source).toContain('await getMaker().oneShot');
    expect(source).toContain('const ownerScopeKey = activeOwnerScopeKey();');
    expect(source).toContain('const beforeSessionAgentDispatch = async () =>');
    expect(source).toContain('beforeDispatch: beforeSessionAgentDispatch');
    expect(source).toContain('isAgentOneShotRouteDisabled(agentKind)');
    const disabledCheck = source.indexOf('isAgentOneShotRouteDisabled(agentKind)');
    const ownerRecheck = source.indexOf('return isAuxiliaryOwnerScopeCurrent(ownerScopeKey, auxiliaryChainSnapshot);', disabledCheck);
    expect(ownerRecheck).toBeGreaterThan(disabledCheck);
  });
});
