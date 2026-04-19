<?php
/**
 * Plugin Name: Hellas Launcher Manifest
 * Description: Stores the Hellas Launcher MC 1.21.1 manifest and per-file mod download links.
 * Version: 1.0.3
 * Author: Hephaestus Forge
 */

if (!defined('ABSPATH')) {
    exit;
}

const HELLAS_LAUNCHER_1211_MANIFEST_OPTION = 'hellas_launcher_1211_manifest_json';
const HELLAS_LAUNCHER_1211_LEGACY_OPTION = 'hellas_launcher_manifest_json';
const HELLAS_LAUNCHER_1211_UPLOAD_ACTION = 'hellas_launcher_1211_upload_mods';
const HELLAS_LAUNCHER_1211_MAX_CHUNK_BYTES = 1048576;
const HELLAS_LAUNCHER_1211_MIN_CHUNK_BYTES = 262144;

function hellas_launcher_1211_chunk_bytes(): int
{
    $reported_limit = function_exists('wp_max_upload_size') ? (int) wp_max_upload_size() : 0;
    $target = HELLAS_LAUNCHER_1211_MAX_CHUNK_BYTES;

    if ($reported_limit > 0) {
        $safe_limit = $reported_limit - 131072;
        if ($safe_limit < HELLAS_LAUNCHER_1211_MIN_CHUNK_BYTES) {
            $safe_limit = max(65536, (int) floor($reported_limit * 0.5));
        }
        $target = min($target, $safe_limit);
    }

    return max(65536, $target);
}

function hellas_launcher_1211_default_manifest(): array
{
    return [
        'schemaVersion' => 2,
        'profiles' => [
            'mc-1.21.1' => [
                'id' => 'mc-1.21.1',
                'label' => 'MC 1.21.1',
                'minecraftVersion' => '1.21.1',
                'forgeVersion' => '1.21.1-52.1.0',
                'javaMajor' => 21,
                'version' => '1.0.0',
                'mods' => [],
                'resourcepacks' => [],
                'files' => [],
            ],
        ],
    ];
}

function hellas_launcher_1211_allowed_profile_ids(): array
{
    return ['mc-1.21.1', '1.21.1'];
}

function hellas_launcher_1211_normalize_manifest(array $manifest): array
{
    $profiles = $manifest['profiles'] ?? [];
    $profile = null;

    if (is_array($profiles)) {
        foreach (hellas_launcher_1211_allowed_profile_ids() as $profile_id) {
            if (isset($profiles[$profile_id]) && is_array($profiles[$profile_id])) {
                $profile = $profiles[$profile_id];
                break;
            }
        }

        if (!$profile) {
            foreach ($profiles as $candidate) {
                if (!is_array($candidate)) {
                    continue;
                }

                if (
                    in_array((string) ($candidate['id'] ?? ''), hellas_launcher_1211_allowed_profile_ids(), true) ||
                    in_array((string) ($candidate['minecraftVersion'] ?? ''), hellas_launcher_1211_allowed_profile_ids(), true) ||
                    in_array((string) ($candidate['manifestKey'] ?? ''), hellas_launcher_1211_allowed_profile_ids(), true)
                ) {
                    $profile = $candidate;
                    break;
                }
            }
        }
    }

    if (!$profile) {
        $profile = hellas_launcher_1211_default_manifest()['profiles']['mc-1.21.1'];
    }

    $profile['id'] = 'mc-1.21.1';
    $profile['minecraftVersion'] = '1.21.1';
    $profile['label'] = $profile['label'] ?? 'MC 1.21.1';
    $profile['javaMajor'] = $profile['javaMajor'] ?? 21;

    return [
        'schemaVersion' => $manifest['schemaVersion'] ?? 2,
        'profiles' => [
            'mc-1.21.1' => $profile,
        ],
    ];
}

function hellas_launcher_1211_manifest_json(): string
{
    $stored = get_option(HELLAS_LAUNCHER_1211_MANIFEST_OPTION, '');
    if (!is_string($stored) || trim($stored) === '') {
        $stored = get_option(HELLAS_LAUNCHER_1211_LEGACY_OPTION, '');
    }

    if (is_string($stored) && trim($stored) !== '') {
        $decoded = json_decode($stored, true);
        if (is_array($decoded)) {
            return wp_json_encode(hellas_launcher_1211_normalize_manifest($decoded), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        }
    }

    return wp_json_encode(hellas_launcher_1211_default_manifest(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
}

function hellas_launcher_1211_manifest(): array
{
    $decoded = json_decode(hellas_launcher_1211_manifest_json(), true);
    return is_array($decoded) ? hellas_launcher_1211_normalize_manifest($decoded) : hellas_launcher_1211_default_manifest();
}

function hellas_launcher_1211_save_manifest(array $manifest): void
{
    update_option(
        HELLAS_LAUNCHER_1211_MANIFEST_OPTION,
        wp_json_encode(hellas_launcher_1211_normalize_manifest($manifest), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
    );
}

function hellas_launcher_1211_sanitize_manifest($value): string
{
    $json = is_string($value) ? wp_unslash($value) : '';
    $decoded = json_decode($json, true);
    if (!is_array($decoded)) {
        add_settings_error(
            HELLAS_LAUNCHER_1211_MANIFEST_OPTION,
            'hellas_launcher_1211_manifest_invalid',
            'Manifest JSON is invalid. The previous value was kept.',
            'error'
        );
        return hellas_launcher_1211_manifest_json();
    }

    return wp_json_encode(hellas_launcher_1211_normalize_manifest($decoded), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
}

function hellas_launcher_1211_register_settings(): void
{
    register_setting('hellas_launcher_1211_manifest', HELLAS_LAUNCHER_1211_MANIFEST_OPTION, [
        'type' => 'string',
        'sanitize_callback' => 'hellas_launcher_1211_sanitize_manifest',
        'default' => wp_json_encode(hellas_launcher_1211_default_manifest(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES),
    ]);
}
add_action('admin_init', 'hellas_launcher_1211_register_settings');

function hellas_launcher_1211_admin_menu(): void
{
    add_options_page(
        'Hellas Launcher 1.21.1 Manifest',
        'Hellas 1.21.1',
        'manage_options',
        'hellas-launcher-1211-manifest',
        'hellas_launcher_1211_render_settings_page'
    );
}
add_action('admin_menu', 'hellas_launcher_1211_admin_menu');

function hellas_launcher_1211_render_settings_page(): void
{
    if (!current_user_can('manage_options')) {
        return;
    }

    $upload_limit = function_exists('wp_max_upload_size') ? size_format(wp_max_upload_size()) : 'server configured limit';
    $chunk_bytes = hellas_launcher_1211_chunk_bytes();
    $chunk_endpoint = rest_url('hellas-launcher-1211/v1/upload-chunk');
    $chunk_nonce = wp_create_nonce('wp_rest');
    $uploaded = isset($_GET['hellas_1211_uploaded']) ? (int) $_GET['hellas_1211_uploaded'] : 0;
    $upload_error = isset($_GET['hellas_1211_error']) ? sanitize_text_field(wp_unslash($_GET['hellas_1211_error'])) : '';
    ?>
    <div class="wrap">
        <h1>Hellas Launcher Manifest</h1>
        <p>Store the MC 1.21.1 launcher version, loader version, and per-file mod download links.</p>
        <?php if ($uploaded > 0): ?>
            <div class="notice notice-success is-dismissible">
                <p><?php echo esc_html(sprintf('%d uploaded mod file(s) were added to the MC 1.21.1 manifest.', $uploaded)); ?></p>
            </div>
        <?php endif; ?>
        <?php if ($upload_error): ?>
            <div class="notice notice-error is-dismissible">
                <p><?php echo esc_html($upload_error); ?></p>
            </div>
        <?php endif; ?>
        <form method="post" action="options.php">
            <?php settings_fields('hellas_launcher_1211_manifest'); ?>
            <textarea
                name="<?php echo esc_attr(HELLAS_LAUNCHER_1211_MANIFEST_OPTION); ?>"
                rows="32"
                style="width:100%;font-family:Consolas,Menlo,monospace;"
            ><?php echo esc_textarea(hellas_launcher_1211_manifest_json()); ?></textarea>
            <?php submit_button('Save Manifest'); ?>
        </form>

        <hr />

        <h2>Upload MC 1.21.1 Mods</h2>
        <p>
            Uploaded files are stored in the WordPress uploads folder and automatically added to
            <code>profiles.mc-1.21.1.mods</code> with URL, file name, and SHA-256.
        </p>
        <p>
            The primary uploader sends every file in <?php echo esc_html(size_format($chunk_bytes)); ?>
            chunks, so a single failed request does not destroy the whole batch. The effective per-request limit is still
            controlled by PHP, WordPress, and the web server. Current WordPress reported limit:
            <strong><?php echo esc_html($upload_limit); ?></strong>.
        </p>
        <div
            id="hellas-1211-uploader"
            data-endpoint="<?php echo esc_url($chunk_endpoint); ?>"
            data-nonce="<?php echo esc_attr($chunk_nonce); ?>"
            data-chunk-size="<?php echo esc_attr((string) $chunk_bytes); ?>"
            style="border:1px solid #c3c4c7;padding:16px;background:#fff;max-width:900px;"
        >
            <input type="file" id="hellas-1211-files" accept=".jar,.zip" multiple />
            <button type="button" class="button button-secondary" id="hellas-1211-start-upload">
                Upload selected files
            </button>
            <p class="description">
                Keep this page open until all selected files show as completed.
            </p>
            <div id="hellas-1211-upload-list" style="margin-top:12px;"></div>
        </div>

        <noscript>
            <p><strong>JavaScript is disabled.</strong> Use the fallback upload below for small files only.</p>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" enctype="multipart/form-data">
                <?php wp_nonce_field(HELLAS_LAUNCHER_1211_UPLOAD_ACTION); ?>
                <input type="hidden" name="action" value="<?php echo esc_attr(HELLAS_LAUNCHER_1211_UPLOAD_ACTION); ?>" />
                <input type="file" name="hellas_mods[]" accept=".jar,.zip" multiple />
                <?php submit_button('Fallback Upload and Add to Manifest', 'secondary'); ?>
            </form>
        </noscript>

        <script>
        (function () {
            const root = document.getElementById('hellas-1211-uploader');
            if (!root || !window.fetch || !window.FormData || !window.Blob) {
                return;
            }

            const input = document.getElementById('hellas-1211-files');
            const startButton = document.getElementById('hellas-1211-start-upload');
            const list = document.getElementById('hellas-1211-upload-list');
            const endpoint = root.getAttribute('data-endpoint');
            const nonce = root.getAttribute('data-nonce');
            const chunkSize = parseInt(root.getAttribute('data-chunk-size'), 10) || 262144;

            function createRow(file) {
                const row = document.createElement('div');
                row.style.margin = '8px 0';

                const name = document.createElement('strong');
                name.textContent = file.name;

                const status = document.createElement('span');
                status.textContent = ' waiting';
                status.style.marginLeft = '8px';

                const progress = document.createElement('progress');
                progress.max = 100;
                progress.value = 0;
                progress.style.display = 'block';
                progress.style.width = '100%';
                progress.style.marginTop = '4px';

                row.appendChild(name);
                row.appendChild(status);
                row.appendChild(progress);
                list.appendChild(row);

                return { progress, status };
            }

            async function readResponse(response) {
                const text = await response.text();
                if (!text) {
                    return {};
                }

                try {
                    return JSON.parse(text);
                } catch (error) {
                    return { message: text };
                }
            }

            function sleep(ms) {
                return new Promise(function (resolve) {
                    window.setTimeout(resolve, ms);
                });
            }

            async function uploadFile(file, row) {
                if (!/\.(jar|zip)$/i.test(file.name)) {
                    throw new Error('Only .jar and .zip files are accepted.');
                }

                const uploadId = [
                    Date.now().toString(36),
                    Math.random().toString(36).slice(2),
                    file.name
                ].join('-').replace(/[^a-zA-Z0-9_.-]/g, '-');
                const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
                let finalResult = null;

                for (let index = 0; index < totalChunks; index++) {
                    const start = index * chunkSize;
                    const end = Math.min(file.size, start + chunkSize);
                    const form = new FormData();
                    form.append('uploadId', uploadId);
                    form.append('fileName', file.name);
                    form.append('chunkIndex', String(index));
                    form.append('totalChunks', String(totalChunks));
                    form.append('chunk', file.slice(start, end), file.name + '.part');

                    row.status.textContent = ' uploading chunk ' + (index + 1) + ' of ' + totalChunks;

                    let body = null;
                    let ok = false;
                    let lastError = '';
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            const response = await fetch(endpoint, {
                                method: 'POST',
                                credentials: 'same-origin',
                                headers: { 'X-WP-Nonce': nonce },
                                body: form
                            });
                            body = await readResponse(response);

                            if (response.ok && !body.code) {
                                ok = true;
                                break;
                            }

                            lastError = body.message || 'Upload request failed.';
                        } catch (error) {
                            lastError = error.message || 'Upload request failed.';
                        }

                        if (attempt < 3) {
                            row.status.textContent = ' retrying chunk ' + (index + 1) + ' of ' + totalChunks;
                            await sleep(1000 * attempt);
                        }
                    }

                    if (!ok) {
                        throw new Error(lastError || 'Upload request failed.');
                    }

                    finalResult = body;
                    row.progress.value = Math.round(((index + 1) / totalChunks) * 100);
                }

                if (!finalResult || !finalResult.complete) {
                    throw new Error('Upload finished, but the server did not assemble the file.');
                }

                row.status.textContent = ' completed';
            }

            startButton.addEventListener('click', async function () {
                const files = Array.from(input.files || []);
                if (!files.length) {
                    return;
                }

                startButton.disabled = true;
                list.innerHTML = '';
                let failures = 0;

                for (const file of files) {
                    const row = createRow(file);
                    try {
                        await uploadFile(file, row);
                    } catch (error) {
                        failures++;
                        row.status.textContent = ' failed: ' + error.message;
                        row.progress.value = 0;
                    }
                }

                if (failures === 0) {
                    const done = document.createElement('p');
                    done.textContent = 'All uploads completed. Reloading the manifest view.';
                    list.appendChild(done);
                    window.setTimeout(function () {
                        window.location.reload();
                    }, 800);
                }

                startButton.disabled = false;
            });
        }());
        </script>

        <p>
            New launcher endpoint:
            <code><?php echo esc_html(rest_url('hellas-launcher-1211/v1/manifest')); ?></code>
        </p>
    </div>
    <?php
}

function hellas_launcher_1211_find_profile(array $manifest, string $profile_id): ?array
{
    if (!in_array($profile_id, hellas_launcher_1211_allowed_profile_ids(), true)) {
        return null;
    }

    $profiles = $manifest['profiles'] ?? [];
    if (!is_array($profiles)) {
        return null;
    }

    if (isset($profiles[$profile_id]) && is_array($profiles[$profile_id])) {
        return $profiles[$profile_id];
    }

    foreach ($profiles as $profile) {
        if (!is_array($profile)) {
            continue;
        }

        if (
            ($profile['id'] ?? '') === $profile_id ||
            ($profile['minecraftVersion'] ?? '') === $profile_id ||
            ($profile['manifestKey'] ?? '') === $profile_id
        ) {
            return $profile;
        }
    }

    return null;
}

function hellas_launcher_1211_upload_dir(): array
{
    $uploads = wp_upload_dir();
    $subdir = 'hellas-launcher/1.21.1/mods';
    $path = trailingslashit($uploads['basedir']) . $subdir;
    $url = trailingslashit($uploads['baseurl']) . $subdir;

    if (!wp_mkdir_p($path)) {
        throw new RuntimeException('Could not create the Hellas mod upload directory.');
    }

    return ['path' => $path, 'url' => $url];
}

function hellas_launcher_1211_chunk_dir(): array
{
    $uploads = wp_upload_dir();
    $subdir = 'hellas-launcher/1.21.1/.chunks';
    $path = trailingslashit($uploads['basedir']) . $subdir;
    $url = trailingslashit($uploads['baseurl']) . $subdir;

    if (!wp_mkdir_p($path)) {
        throw new RuntimeException('Could not create the Hellas chunk upload directory.');
    }

    return ['path' => $path, 'url' => $url];
}

function hellas_launcher_1211_validate_mod_file_name(string $name): string
{
    $file_name = sanitize_file_name($name);
    $extension = strtolower(pathinfo($file_name, PATHINFO_EXTENSION));

    if ($file_name === '' || !in_array($extension, ['jar', 'zip'], true)) {
        throw new RuntimeException('Only .jar and .zip files are accepted.');
    }

    return $file_name;
}

function hellas_launcher_1211_mod_id_from_file_name(string $file_name): string
{
    $base_name = pathinfo($file_name, PATHINFO_FILENAME);
    $without_version = preg_replace('/[-_. ](?:mc)?v?\d+(?:\.\d+)+(?:[-+_. ].*)?$/i', '', $base_name);
    $candidate = is_string($without_version) && $without_version !== '' ? $without_version : $base_name;
    $id = sanitize_title($candidate);

    return $id !== '' ? $id : sanitize_title($base_name);
}

function hellas_launcher_1211_mod_family(array $mod): string
{
    $file_name = (string) ($mod['fileName'] ?? '');
    if ($file_name !== '') {
        return hellas_launcher_1211_mod_id_from_file_name($file_name);
    }

    $url = (string) ($mod['url'] ?? '');
    if ($url !== '') {
        $path = (string) parse_url($url, PHP_URL_PATH);
        $from_url = basename($path);
        if ($from_url !== '' && preg_match('/\.(jar|zip)$/i', $from_url)) {
            return hellas_launcher_1211_mod_id_from_file_name(rawurldecode($from_url));
        }
    }

    return sanitize_title((string) ($mod['id'] ?? ''));
}

function hellas_launcher_1211_delete_uploaded_mod_file(array $upload_dir, array $mod, string $replacement_file_name): void
{
    $file_name = (string) ($mod['fileName'] ?? '');
    if ($file_name === '' || $file_name === $replacement_file_name) {
        return;
    }

    $candidate = realpath(trailingslashit($upload_dir['path']) . basename($file_name));
    $root = realpath($upload_dir['path']);

    if (
        !$candidate ||
        !$root ||
        !is_file($candidate) ||
        strpos($candidate, $root . DIRECTORY_SEPARATOR) !== 0
    ) {
        return;
    }

    unlink($candidate);
}

function hellas_launcher_1211_mod_entry(array $upload_dir, string $file_name, string $destination): array
{
    return [
        'id' => hellas_launcher_1211_mod_id_from_file_name($file_name),
        'fileName' => $file_name,
        'url' => trailingslashit($upload_dir['url']) . rawurlencode($file_name),
        'sha256' => hash_file('sha256', $destination),
    ];
}

function hellas_launcher_1211_uploaded_files(): array
{
    if (empty($_FILES['hellas_mods']) || !is_array($_FILES['hellas_mods']['name'])) {
        return [];
    }

    $files = [];
    foreach ($_FILES['hellas_mods']['name'] as $index => $name) {
        $files[] = [
            'name' => $name,
            'type' => $_FILES['hellas_mods']['type'][$index] ?? '',
            'tmp_name' => $_FILES['hellas_mods']['tmp_name'][$index] ?? '',
            'error' => $_FILES['hellas_mods']['error'][$index] ?? UPLOAD_ERR_NO_FILE,
            'size' => $_FILES['hellas_mods']['size'][$index] ?? 0,
        ];
    }

    return $files;
}

function hellas_launcher_1211_add_mod_to_manifest(array $manifest, array $mod, ?array $upload_dir = null): array
{
    $manifest = hellas_launcher_1211_normalize_manifest($manifest);
    $mods = $manifest['profiles']['mc-1.21.1']['mods'] ?? [];
    if (!is_array($mods)) {
        $mods = [];
    }

    $replacement_family = hellas_launcher_1211_mod_family($mod);
    $mods = array_values(array_filter($mods, static function ($existing) use ($mod, $replacement_family, $upload_dir) {
        if (!is_array($existing)) {
            return false;
        }

        $same_file = ($existing['fileName'] ?? '') === ($mod['fileName'] ?? '');
        $same_id = ($existing['id'] ?? '') === ($mod['id'] ?? '');
        $same_family = $replacement_family !== '' && hellas_launcher_1211_mod_family($existing) === $replacement_family;
        $replaced = $same_file || $same_id || $same_family;

        if ($replaced && $upload_dir) {
            hellas_launcher_1211_delete_uploaded_mod_file($upload_dir, $existing, (string) ($mod['fileName'] ?? ''));
        }

        return !$replaced;
    }));
    $mods[] = $mod;
    $manifest['profiles']['mc-1.21.1']['mods'] = $mods;

    return $manifest;
}

function hellas_launcher_1211_handle_upload_error(int $code): string
{
    $messages = [
        UPLOAD_ERR_INI_SIZE => 'The uploaded file exceeds the PHP upload_max_filesize limit.',
        UPLOAD_ERR_FORM_SIZE => 'The uploaded file exceeds the form upload limit.',
        UPLOAD_ERR_PARTIAL => 'The uploaded file was only partially uploaded.',
        UPLOAD_ERR_NO_FILE => 'No file was uploaded.',
        UPLOAD_ERR_NO_TMP_DIR => 'Missing PHP temporary upload directory.',
        UPLOAD_ERR_CANT_WRITE => 'Failed to write uploaded file to disk.',
        UPLOAD_ERR_EXTENSION => 'A PHP extension stopped the upload.',
    ];

    return $messages[$code] ?? 'Unknown upload error.';
}

function hellas_launcher_1211_handle_mod_uploads(): void
{
    if (!current_user_can('manage_options')) {
        wp_die('You are not allowed to upload Hellas mods.');
    }

    check_admin_referer(HELLAS_LAUNCHER_1211_UPLOAD_ACTION);

    $redirect_url = admin_url('options-general.php?page=hellas-launcher-1211-manifest');
    $manifest = hellas_launcher_1211_manifest();
    $uploaded_count = 0;

    try {
        $upload_dir = hellas_launcher_1211_upload_dir();

        foreach (hellas_launcher_1211_uploaded_files() as $file) {
            if ((int) $file['error'] === UPLOAD_ERR_NO_FILE) {
                continue;
            }

            if ((int) $file['error'] !== UPLOAD_ERR_OK) {
                throw new RuntimeException(hellas_launcher_1211_handle_upload_error((int) $file['error']));
            }

            if (!is_uploaded_file($file['tmp_name'])) {
                throw new RuntimeException('Upload validation failed.');
            }

            if ((int) ($file['size'] ?? 0) <= 0) {
                throw new RuntimeException('Uploaded mod file is empty.');
            }

            $file_name = hellas_launcher_1211_validate_mod_file_name((string) $file['name']);
            $destination = trailingslashit($upload_dir['path']) . $file_name;

            if (!move_uploaded_file($file['tmp_name'], $destination)) {
                throw new RuntimeException('Could not move uploaded file into the Hellas mod upload directory.');
            }

            $manifest = hellas_launcher_1211_add_mod_to_manifest(
                $manifest,
                hellas_launcher_1211_mod_entry($upload_dir, $file_name, $destination),
                $upload_dir
            );
            $uploaded_count++;
        }

        if ($uploaded_count > 0) {
            hellas_launcher_1211_save_manifest($manifest);
        }

        wp_safe_redirect(add_query_arg('hellas_1211_uploaded', (string) $uploaded_count, $redirect_url));
        exit;
    } catch (Throwable $error) {
        wp_safe_redirect(add_query_arg('hellas_1211_error', rawurlencode($error->getMessage()), $redirect_url));
        exit;
    }
}
add_action('admin_post_' . HELLAS_LAUNCHER_1211_UPLOAD_ACTION, 'hellas_launcher_1211_handle_mod_uploads');

function hellas_launcher_1211_remove_directory(string $directory, string $root): void
{
    $real_directory = realpath($directory);
    $real_root = realpath($root);

    if (
        !$real_directory ||
        !$real_root ||
        $real_directory === $real_root ||
        strpos($real_directory . DIRECTORY_SEPARATOR, $real_root . DIRECTORY_SEPARATOR) !== 0
    ) {
        return;
    }

    foreach (scandir($real_directory) ?: [] as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }

        $path = $real_directory . DIRECTORY_SEPARATOR . $item;
        if (is_dir($path)) {
            hellas_launcher_1211_remove_directory($path, $real_root);
        } elseif (is_file($path)) {
            unlink($path);
        }
    }

    rmdir($real_directory);
}

function hellas_launcher_1211_cleanup_old_chunks(string $chunk_root): void
{
    $max_age = DAY_IN_SECONDS;
    $now = time();

    foreach (scandir($chunk_root) ?: [] as $item) {
        if ($item === '.' || $item === '..') {
            continue;
        }

        $path = trailingslashit($chunk_root) . $item;
        if (is_dir($path) && $now - (int) filemtime($path) > $max_age) {
            hellas_launcher_1211_remove_directory($path, $chunk_root);
        }
    }
}

function hellas_launcher_1211_rest_upload_chunk(WP_REST_Request $request)
{
    try {
        $upload_id = sanitize_key((string) $request->get_param('uploadId'));
        $file_name = hellas_launcher_1211_validate_mod_file_name((string) $request->get_param('fileName'));
        $chunk_index = (int) $request->get_param('chunkIndex');
        $total_chunks = (int) $request->get_param('totalChunks');
        $files = $request->get_file_params();
        $file = $files['chunk'] ?? null;

        if ($upload_id === '') {
            throw new RuntimeException('Missing upload id.');
        }

        if ($total_chunks < 1 || $total_chunks > 100000 || $chunk_index < 0 || $chunk_index >= $total_chunks) {
            throw new RuntimeException('Invalid upload chunk index.');
        }

        if (!is_array($file)) {
            throw new RuntimeException('Missing upload chunk.');
        }

        if ((int) ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            throw new RuntimeException(hellas_launcher_1211_handle_upload_error((int) ($file['error'] ?? UPLOAD_ERR_NO_FILE)));
        }

        if (empty($file['tmp_name']) || !is_uploaded_file($file['tmp_name'])) {
            throw new RuntimeException('Upload chunk validation failed.');
        }

        $chunk_dir = hellas_launcher_1211_chunk_dir();
        hellas_launcher_1211_cleanup_old_chunks($chunk_dir['path']);

        $session_dir = trailingslashit($chunk_dir['path']) . $upload_id;
        if (!wp_mkdir_p($session_dir)) {
            throw new RuntimeException('Could not create upload session directory.');
        }

        $meta = [
            'fileName' => $file_name,
            'totalChunks' => $total_chunks,
            'updatedAt' => time(),
        ];
        file_put_contents(trailingslashit($session_dir) . 'upload.json', wp_json_encode($meta));

        $chunk_path = trailingslashit($session_dir) . sprintf('%06d.part', $chunk_index);
        if (file_exists($chunk_path)) {
            unlink($chunk_path);
        }

        if (!move_uploaded_file($file['tmp_name'], $chunk_path)) {
            throw new RuntimeException('Could not store upload chunk.');
        }

        $received_chunks = 0;
        for ($index = 0; $index < $total_chunks; $index++) {
            if (is_file(trailingslashit($session_dir) . sprintf('%06d.part', $index))) {
                $received_chunks++;
            }
        }

        if ($received_chunks < $total_chunks) {
            return rest_ensure_response([
                'complete' => false,
                'receivedChunks' => $received_chunks,
                'totalChunks' => $total_chunks,
            ]);
        }

        $upload_dir = hellas_launcher_1211_upload_dir();
        $destination = trailingslashit($upload_dir['path']) . $file_name;
        $temporary_destination = $destination . '.uploading-' . $upload_id;
        $output = fopen($temporary_destination, 'wb');

        if (!$output) {
            throw new RuntimeException('Could not assemble uploaded file.');
        }

        try {
            for ($index = 0; $index < $total_chunks; $index++) {
                $part_path = trailingslashit($session_dir) . sprintf('%06d.part', $index);
                $input = fopen($part_path, 'rb');
                if (!$input) {
                    throw new RuntimeException('Could not read upload chunk.');
                }
                stream_copy_to_stream($input, $output);
                fclose($input);
            }
        } finally {
            fclose($output);
        }

        if (file_exists($destination) && !unlink($destination)) {
            unlink($temporary_destination);
            throw new RuntimeException('Could not replace existing uploaded mod file.');
        }

        if (!rename($temporary_destination, $destination)) {
            unlink($temporary_destination);
            throw new RuntimeException('Could not publish uploaded mod file.');
        }

        if ((int) filesize($destination) <= 0) {
            unlink($destination);
            throw new RuntimeException('Uploaded mod file is empty.');
        }

        $manifest = hellas_launcher_1211_add_mod_to_manifest(
            hellas_launcher_1211_manifest(),
            hellas_launcher_1211_mod_entry($upload_dir, $file_name, $destination),
            $upload_dir
        );
        hellas_launcher_1211_save_manifest($manifest);
        hellas_launcher_1211_remove_directory($session_dir, $chunk_dir['path']);

        return rest_ensure_response([
            'complete' => true,
            'mod' => hellas_launcher_1211_mod_entry($upload_dir, $file_name, $destination),
        ]);
    } catch (Throwable $error) {
        return new WP_Error('hellas_chunk_upload_failed', $error->getMessage(), ['status' => 400]);
    }
}

function hellas_launcher_1211_register_routes(): void
{
    register_rest_route('hellas-launcher-1211/v1', '/manifest', [
        'methods' => 'GET',
        'permission_callback' => '__return_true',
        'callback' => static function () {
            return rest_ensure_response(hellas_launcher_1211_manifest());
        },
    ]);

    register_rest_route('hellas-launcher-1211/v1', '/manifest/(?P<profile>[A-Za-z0-9._-]+)', [
        'methods' => 'GET',
        'permission_callback' => '__return_true',
        'callback' => static function (WP_REST_Request $request) {
            $manifest = hellas_launcher_1211_manifest();
            $profile = hellas_launcher_1211_find_profile($manifest, (string) $request['profile']);
            if (!$profile) {
                return new WP_Error('hellas_profile_not_found', 'Profile not found.', ['status' => 404]);
            }
            return rest_ensure_response($profile);
        },
    ]);

    register_rest_route('hellas-launcher-1211/v1', '/upload-chunk', [
        'methods' => 'POST',
        'permission_callback' => static function () {
            return current_user_can('manage_options');
        },
        'callback' => 'hellas_launcher_1211_rest_upload_chunk',
    ]);

}
add_action('rest_api_init', 'hellas_launcher_1211_register_routes');

function hellas_launcher_1211_activate(): void
{
    if (!get_option(HELLAS_LAUNCHER_1211_MANIFEST_OPTION)) {
        add_option(
            HELLAS_LAUNCHER_1211_MANIFEST_OPTION,
            wp_json_encode(hellas_launcher_1211_default_manifest(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
        );
    }
}
register_activation_hook(__FILE__, 'hellas_launcher_1211_activate');
