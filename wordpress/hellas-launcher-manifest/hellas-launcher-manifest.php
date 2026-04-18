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
    ?>
    <div class="wrap">
        <h1>Hellas Launcher Manifest</h1>
        <p>Store the MC 1.21.1 launcher version, loader version, and per-file mod download links.</p>
        <form method="post" action="options.php">
            <?php settings_fields('hellas_launcher_1211_manifest'); ?>
            <textarea
                name="<?php echo esc_attr(HELLAS_LAUNCHER_1211_MANIFEST_OPTION); ?>"
                rows="32"
                style="width:100%;font-family:Consolas,Menlo,monospace;"
            ><?php echo esc_textarea(hellas_launcher_1211_manifest_json()); ?></textarea>
            <?php submit_button('Save Manifest'); ?>
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
