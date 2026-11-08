export function safeWhatsappGroupUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const [url, query, ...extra] = value.split('?');
  if (
    extra.length ||
    !/^https:\/\/chat\.whatsapp\.com(?::443)?\/[a-z0-9]{1,128}(?![\s\S])/i.test(
      url,
    ) ||
    (query !== undefined && !/^mode=[a-zA-Z0-9_-]+(?![\s\S])/.test(query))
  )
    return null;
  return value;
}
