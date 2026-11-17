<?php
declare(strict_types=1);

function hala_json(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function hala_config(): array
{
    $configFile = __DIR__ . '/config.php';
    if (!is_file($configFile)) {
        hala_json(503, ['error' => 'storage_not_configured']);
    }

    $config = require $configFile;
    if (!is_array($config) || !is_string($config['api_key'] ?? null) || strlen($config['api_key']) < 32 ||
        !is_int($config['max_bytes'] ?? 104857600) || $config['max_bytes'] < 1 ||
        str_contains($config['api_key'], 'replace-this')) {
        hala_json(503, ['error' => 'storage_not_configured']);
    }

    return $config;
}

function hala_authorize(array $config): void
{
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    $authorization = $headers['Authorization'] ?? $headers['authorization'] ?? $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!is_string($authorization) || !preg_match('/^Bearer\s+(.+)$/i', $authorization, $matches) ||
        !hash_equals($config['api_key'], trim($matches[1]))) {
        hala_json(401, ['error' => 'unauthorized']);
    }
}

function hala_key(): string
{
    $key = $_POST['key'] ?? $_GET['key'] ?? '';
    if (!is_string($key) || !preg_match('#^[a-f0-9]{24}/[a-f0-9]{24}/[a-f0-9]{24}/(?:original|thumb)$#iD', $key)) {
        hala_json(400, ['error' => 'invalid_key']);
    }
    return $key;
}

function hala_storage_path(array $config, string $key, bool $createDirectory = false): string
{
    $root = $config['storage_root'] ?? dirname(__DIR__, 2) . '/hala-private-storage';
    if (!is_string($root) || $root === '') {
        hala_json(503, ['error' => 'storage_not_configured']);
    }
    if (!is_dir($root) && !mkdir($root, 0750, true) && !is_dir($root)) {
        hala_json(500, ['error' => 'storage_unavailable']);
    }
    $rootPath = realpath($root);
    if ($rootPath === false) {
        hala_json(500, ['error' => 'storage_unavailable']);
    }

    $destination = $rootPath . '/' . $key;
    $directory = dirname($destination);
    if ($createDirectory && !is_dir($directory) && !mkdir($directory, 0750, true) && !is_dir($directory)) {
        hala_json(500, ['error' => 'storage_unavailable']);
    }
    if (!$createDirectory && !is_dir($directory)) {
        return $destination;
    }
    $realDirectory = realpath($directory);
    if ($realDirectory === false || !str_starts_with($realDirectory . DIRECTORY_SEPARATOR, $rootPath . DIRECTORY_SEPARATOR)) {
        hala_json(400, ['error' => 'invalid_key']);
    }
    return $realDirectory . '/' . basename($destination);
}

function hala_allowed_mime_types(): array
{
    return [
        'image/jpeg', 'image/png', 'image/webp', 'image/gif',
        'video/mp4', 'video/quicktime',
        'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/vnd.wave',
        'application/pdf', 'application/zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain'
    ];
}

function hala_require_method(string ...$methods): void
{
    if (!in_array($_SERVER['REQUEST_METHOD'] ?? '', $methods, true)) {
        header('Allow: ' . implode(', ', $methods));
        hala_json(405, ['error' => 'method_not_allowed']);
    }
}

$halaConfig = hala_config();
hala_authorize($halaConfig);
