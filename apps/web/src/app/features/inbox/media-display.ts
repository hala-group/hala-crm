const imageTypes = new Set(['image', 'sticker']);

export function mediaSourceUrl(id: string, kind: string, fullSize = false): string {
  const path = `/api/v1/media/${encodeURIComponent(id)}`;
  return imageTypes.has(kind) && !fullSize ? `${path}?thumbnail=true` : path;
}

export function mediaKindLabel(kind: string): string {
  switch (kind) {
    case 'image':
      return 'صورة';
    case 'video':
      return 'فيديو';
    case 'voice':
      return 'رسالة صوتية';
    case 'audio':
      return 'ملف صوتي';
    case 'sticker':
      return 'ملصق';
    case 'document':
      return 'مستند';
    default:
      return 'مرفق';
  }
}
