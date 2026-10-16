export function sanitizeReportUrl(href) {
  const url = new URL(href);
  const projectIds = url.searchParams.getAll('project_id');
  url.search = '';
  if (projectIds.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectIds[0])) {
    url.searchParams.set('project_id', projectIds[0]);
  }
  url.hash = url.hash.split('?')[0];
  if (/^#(?:token|access_token|secret|session)[=:]/i.test(url.hash)) url.hash = '';
  url.username = ''; url.password = '';
  return url.toString();
}

