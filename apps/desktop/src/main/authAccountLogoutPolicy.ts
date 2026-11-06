export function loggedOutAccountKeySet(
  vault: { loggedOutAccountKeys?: string[] } & object,
): Set<string> {
  return new Set(vault.loggedOutAccountKeys ?? []);
}

export function restoreLoggedOutVaultAccount(
  vault: { loggedOutAccountKeys?: string[] } & object,
  accountKey: string,
): void {
  if (!vault.loggedOutAccountKeys?.includes(accountKey)) return;
  const remaining = vault.loggedOutAccountKeys.filter((key) => key !== accountKey);
  if (remaining.length > 0) {
    vault.loggedOutAccountKeys = remaining;
  } else {
    delete vault.loggedOutAccountKeys;
  }
}
