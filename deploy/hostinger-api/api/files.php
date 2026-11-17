<?php
declare(strict_types=1);

require __DIR__ . '/_bootstrap.php';
hala_require_method('GET', 'HEAD', 'DELETE');

$key = hala_key();
$path = hala_storage_path($halaConfig, $key);
if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
    if (!is_file($path)) {
        hala_json(404, ['error' => 'file_not_found']);
    }
    if (!unlink($path)) {
        hala_json(500, ['error' => 'file_delete_failed']);
    }
    hala_json(200, ['deleted' => true, 'key' => $key]);
}

if (!is_file($path)) {
    hala_json(404, ['error' => 'file_not_found']);
}
$finfo = new finfo(FILEINFO_MIME_TYPE);
$mimeType = $finfo->file($path);
header('Content-Type: ' . (is_string($mimeType) ? $mimeType : 'application/octet-stream'));
header('Content-Length: ' . (string)filesize($path));
header('Cache-Control: private, no-store');
header('X-Content-Type-Options: nosniff');
header('Content-Disposition: inline; filename="' . basename($key) . '"');
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    readfile($path);
}
