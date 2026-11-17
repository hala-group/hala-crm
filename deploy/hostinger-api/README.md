# Hostinger private media API

Copy the contents of `api/` to `public_html/api/` on the Hostinger domain. Copy
`config.php.example` to `config.php`, set a randomly generated secret of at least
32 characters, and keep the storage directory outside `public_html`. The
`.htaccess` file prevents directory listing and direct access to configuration.

Configure the same secret in Hala's server-side environment:

```env
STORAGE_DRIVER=hostinger
HOSTINGER_STORAGE_API_URL=https://cyan-frog-373577.hostingersite.com/api
HOSTINGER_STORAGE_API_KEY=<same-random-secret>
```

Restart/recreate both the API and worker after changing these variables. Do not
place this secret in Angular environment files or expose it to a browser.
New files use Hostinger; existing media stays at its recorded provider and does
not need to be migrated before switching.

The protocol keeps the supplied `POST /api/upload.php` and multipart field
`file`, and adds a required private object `key`. It returns a relative `url`
plus the opaque `key`. Hala stores and uses the key; it does not expose the
Hostinger URL to end users.

| Operation | Endpoint | Authentication |
| --- | --- | --- |
| Upload | `POST /api/upload.php` (`file`, `key`) | `Authorization: Bearer <key>` |
| Read | `GET /api/files.php?key=<object-key>` | `Authorization: Bearer <key>` |
| Delete | `DELETE /api/files.php?key=<object-key>` | `Authorization: Bearer <key>` |

Object keys are restricted to Hala's tenant/account/media object paths. Uploads
are MIME-sniffed and limited to 100 MiB by default. Adjust `max_bytes` only if
the PHP host's `upload_max_filesize` and `post_max_size` are also configured.
Files are private, and every read/delete is authenticated server-to-server.
