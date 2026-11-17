<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';
hala_require_method('POST');

$key = hala_key();
$upload = $_FILES['file'] ?? null;
if (!is_array($upload) || ($upload['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($upload['tmp_name'] ?? '')) {
    hala_json(400, ['error' => 'file_required']);
}

$size = (int)($upload['size'] ?? 0);
$maxBytes = (int)($halaConfig['max_bytes'] ?? 104857600);
if ($size < 1 || $size > $maxBytes) {
    hala_json(413, ['error' => 'file_too_large']);
}

$finfo = new finfo(FILEINFO_MIME_TYPE);
$mimeType = $finfo->file($upload['tmp_name']);
if (!is_string($mimeType) || !in_array($mimeType, hala_allowed_mime_types(), true)) {
    hala_json(415, ['error' => 'unsupported_file_type']);
}

$path = hala_storage_path($halaConfig, $key, true);
$temporary = $path . '.' . bin2hex(random_bytes(8)) . '.tmp';
if (!move_uploaded_file($upload['tmp_name'], $temporary)) {
    hala_json(500, ['error' => 'file_write_failed']);
}
chmod($temporary, 0640);
if (!rename($temporary, $path)) {
    @unlink($temporary);
    hala_json(500, ['error' => 'file_write_failed']);
}

hala_json(201, [
    'key' => $key,
    'url' => 'api/files.php?key=' . rawurlencode($key),
    'mimeType' => $mimeType,
    'size' => $size
]);
