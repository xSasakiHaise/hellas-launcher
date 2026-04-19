<?php
/**
 * Plugin Name: Hellas Launcher Manifest
 * Description: Stores the Hellas Launcher MC 1.21.1 manifest and per-file mod download links.
 * Version: 1.0.1
 * Author: Hephaestus Forge
 */

if (!defined('ABSPATH')) {
    exit;
}

const HELLAS_LAUNCHER_1211_MANIFEST_OPTION = 'hellas_launcher_1211_manifest_json';
const HELLAS_LAUNCHER_1211_LEGACY_OPTION = 'hellas_launcher_manifest_json';
const HELLAS_LAUNCHER_1211_UPLOAD_ACTION = 'hellas_launcher_1211_upload_mods';

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
            This plugin does not impose its own file size limit. The effective upload limit is still controlled by
            PHP, WordPress, and the web server. Current WordPress reported limit:
            <strong><?php echo esc_html($upload_limit); ?></strong>.
        </p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" enctype="multipart/form-data">
            <?php wp_nonce_field(HELLAS_LAUNCHER_1211_UPLOAD_ACTION); ?>
            <input type="hidden" name="action" value="<?php echo esc_attr(HELLAS_LAUNCHER_1211_UPLOAD_ACTION); ?>" />
            <input type="file" name="hellas_mods[]" accept=".jar,.zip" multiple />
            <?php submit_button('Upload and Add to Manifest', 'secondary'); ?>
        </form>

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

function hellas_launcher_1211_add_mod_to_manifest(array $manifest, array $mod): array
{
    $manifest = hellas_launcher_1211_normalize_manifest($manifest);
    $mods = $manifest['profiles']['mc-1.21.1']['mods'] ?? [];
    if (!is_array($mods)) {
        $mods = [];
    }

    $mods = array_values(array_filter($mods, static function ($existing) use ($mod) {
        if (!is_array($existing)) {
            return false;
        }

        return ($existing['fileName'] ?? '') !== $mod['fileName'] && ($existing['id'] ?? '') !== $mod['id'];
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

            $extension = strtolower(pathinfo((string) $file['name'], PATHINFO_EXTENSION));
            if (!in_array($extension, ['jar', 'zip'], true)) {
                throw new RuntimeException('Only .jar and .zip files are accepted.');
            }

            if (!is_uploaded_file($file['tmp_name'])) {
                throw new RuntimeException('Upload validation failed.');
            }

            $file_name = wp_unique_filename($upload_dir['path'], sanitize_file_name((string) $file['name']));
            $destination = trailingslashit($upload_dir['path']) . $file_name;

            if (!move_uploaded_file($file['tmp_name'], $destination)) {
                throw new RuntimeException('Could not move uploaded file into the Hellas mod upload directory.');
            }

            $file_url = trailingslashit($upload_dir['url']) . rawurlencode($file_name);
            $manifest = hellas_launcher_1211_add_mod_to_manifest($manifest, [
                'id' => sanitize_title(pathinfo($file_name, PATHINFO_FILENAME)),
                'fileName' => $file_name,
                'url' => $file_url,
                'sha256' => hash_file('sha256', $destination),
            ]);
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
