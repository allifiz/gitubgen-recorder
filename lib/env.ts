function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} belum diisi.`);
  return value;
}

export function githubConfig() {
  return {
    token: required('GITHUB_TOKEN'),
    org: process.env.GITHUB_ORG?.trim() || 'GO-Bimbel',
    projectNumber: Number(process.env.GITHUB_PROJECT_NUMBER || 11)
  };
}

export function tursoConfig() {
  return {
    url: required('TURSO_DATABASE_URL'),
    authToken: required('TURSO_AUTH_TOKEN')
  };
}

export function cronSecret() { return required('CRON_SECRET'); }
export function apiSecret() { return required('RECORDER_API_SECRET'); }
