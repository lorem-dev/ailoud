const BY_EXTENSION: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
};

/** The extension of a path, including the leading dot, or "" if there is none. */
export function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot);
}

/** The media type for a path, or null when the extension is not media. */
export function mimeForPath(path: string): string | null {
  const ext = extensionOf(path);
  if (ext === '') return null;
  return BY_EXTENSION[ext.slice(1).toLowerCase()] ?? null;
}
