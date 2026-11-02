export async function readJsonResponse(response) {
  try {
    const value = await response.json();
    if (value && typeof value === 'object') return value;
  } catch { /* A proxy may return HTML instead of the service's JSON. */ }
  if (response.status >= 500) throw new Error('Сервис багов временно недоступен. Попробуйте ещё раз позже.');
  if (response.status === 403) throw new Error('Сервер запретил это действие. Для входа используйте выданные имя и PIN.');
  throw new Error('Сервис багов вернул некорректный ответ. Попробуйте ещё раз позже.');
}
