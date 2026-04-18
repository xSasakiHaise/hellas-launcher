<?php
/**
 * Plugin Name: Hellas Launcher Manifest
 * Description: Stores Hellas Launcher profile manifests and exposes old and new launcher update endpoints.
 * Version: 1.0.0
 * Author: Hephaestus Forge
 */

if (!defined('ABSPATH')) {
    exit;
}

const HELLAS_LAUNCHER_MANIFEST_OPTION = 'hellas_launcher_manifest_json';

function hellas_launcher_default_manifest(): array
{
    return [
        'schemaVersion' => 2,
        'profiles' => [
            'mc-1.16.5' => [
                'id' => 'mc-1.16.5',
                'label' => 'MC 1.16.5',
                'minecraftVersion' => '1.16.5',
                'forgeVersion' => '1.16.5-36.2.42',
                'javaMajor' => 8,
                'version' => '1.0.0',
                'url' => '',
                'sha256' => '',
                'mods' => [],
                'resourcepacks' => [],
                'files' => [],
            ],
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

function hellas_launcher_manifest_json(): string
{
    $stored = get_option(HELLAS_LAUNCHER_MANIFEST_OPTION, '');
    if (is_string($stored) && trim($stored) !== '') {
        return $stored;
    }

    return wp_json_encode(hellas_launcher_default_manifest(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
}

function hellas_launcher_manifest(): array
{
    $decoded = json_decode(hellas_launcher_manifest_json(), true);
    return is_array($decoded) ? $decoded : hellas_launcher_default_manifest();
}

function hellas_launcher_sanitize_manifest($value): string
{
    $json = is_string($value) ? wp_unslash($value) : '';
    $decoded = json_decode($json, true);
    if (!is_array($decoded)) {
        add_settings_error(
            HELLAS_LAUNCHER_MANIFEST_OPTION,
            'hellas_launcher_manifest_invalid',
            'Manifest JSON is invalid. The previous value was kept.',
            'error'
        );
        return hellas_launcher_manifest_json();
    }

    return wp_json_encode($decoded, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
}

function hellas_launcher_register_settings(): void
{
    register_setting('hellas_launcher_manifest', HELLAS_LAUNCHER_MANIFEST_OPTION, [
        'type' => 'string',
        'sanitize_callback' => 'hellas_launcher_sanitize_manifest',
        'default' => wp_json_encode(hellas_launcher_default_manifest(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES),
    ]);
}
add_action('admin_init', 'hellas_launcher_register_settings');

function hellas_launcher_admin_menu(): void
{
    add_options_page(
        'Hellas Launcher Manifest',
        'Hellas Launcher',
        'manage_options',
        'hellas-launcher-manifest',
        'hellas_launcher_render_settings_page'
    );
}
add_action('admin_menu', 'hellas_launcher_admin_menu');

function hellas_launcher_render_settings_page(): void
{
    if (!current_user_can('manage_options')) {
        return;
    }
    ?>
    <div class="wrap">
        <h1>Hellas Launcher Manifest</h1>
        <p>Store the official launcher profiles, versions, loader versions, and per-file mod download links.</p>
        <form method="post" action="options.php">
            <?php settings_fields('hellas_launcher_manifest'); ?>
            <textarea
                name="<?php echo esc_attr(HELLAS_LAUNCHER_MANIFEST_OPTION); ?>"
                rows="32"
                style="width:100%;font-family:Consolas,Menlo,monospace;"
            ><?php echo esc_textarea(hellas_launcher_manifest_json()); ?></textarea>
            <?php submit_button('Save Manifest'); ?>
        </form>
        <p>
            New launcher endpoint:
            <code><?php echo esc_html(rest_url('hellas-launcher/v1/manifest')); ?></code>
        </p>
        <p>
            Old launcher compatibility endpoint:
            <code><?php echo esc_html(home_url('/download/launcher/latest/compact')); ?></code>
        </p>
    </div>
    <?php
}

function hellas_launcher_find_profile(array $manifest, string $profile_id): ?array
{
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

function hellas_launcher_legacy_payload(): array
{
    $manifest = hellas_launcher_manifest();
    $profile = hellas_launcher_find_profile($manifest, 'mc-1.16.5')
        ?? hellas_launcher_find_profile($manifest, '1.16.5')
        ?? [];
    $archive = $profile['archive'] ?? $profile['modpack'] ?? [];

    return [
        'version' => $profile['version'] ?? $manifest['version'] ?? null,
        'url' => $profile['url'] ?? $archive['url'] ?? '',
        'sha256' => $profile['sha256'] ?? $profile['hash'] ?? $archive['sha256'] ?? $archive['hash'] ?? null,
    ];
}

function hellas_launcher_register_routes(): void
{
    register_rest_route('hellas-launcher/v1', '/manifest', [
        'methods' => 'GET',
        'permission_callback' => '__return_true',
        'callback' => static function () {
            return rest_ensure_response(hellas_launcher_manifest());
        },
    ]);

    register_rest_route('hellas-launcher/v1', '/manifest/(?P<profile>[A-Za-z0-9._-]+)', [
        'methods' => 'GET',
        'permission_callback' => '__return_true',
        'callback' => static function (WP_REST_Request $request) {
            $manifest = hellas_launcher_manifest();
            $profile = hellas_launcher_find_profile($manifest, (string) $request['profile']);
            if (!$profile) {
                return new WP_Error('hellas_profile_not_found', 'Profile not found.', ['status' => 404]);
            }
            return rest_ensure_response($profile);
        },
    ]);

    register_rest_route('hellas-launcher/v1', '/latest', [
        'methods' => 'GET',
        'permission_callback' => '__return_true',
        'callback' => static function () {
            return rest_ensure_response(hellas_launcher_legacy_payload());
        },
    ]);

    register_rest_route('hellas-launcher/v1', '/latest/compact', [
        'methods' => 'GET',
        'permission_callback' => '__return_true',
        'callback' => static function () {
            return rest_ensure_response(hellas_launcher_legacy_payload());
        },
    ]);
}
add_action('rest_api_init', 'hellas_launcher_register_routes');

function hellas_launcher_add_rewrite_rule(): void
{
    add_rewrite_rule('^download/launcher/latest/compact/?$', 'index.php?hellas_launcher_legacy=1', 'top');
}
add_action('init', 'hellas_launcher_add_rewrite_rule');

function hellas_launcher_query_vars(array $vars): array
{
    $vars[] = 'hellas_launcher_legacy';
    return $vars;
}
add_filter('query_vars', 'hellas_launcher_query_vars');

function hellas_launcher_template_redirect(): void
{
    if (!get_query_var('hellas_launcher_legacy')) {
        return;
    }

    wp_send_json(hellas_launcher_legacy_payload());
}
add_action('template_redirect', 'hellas_launcher_template_redirect');

function hellas_launcher_activate(): void
{
    if (!get_option(HELLAS_LAUNCHER_MANIFEST_OPTION)) {
        add_option(
            HELLAS_LAUNCHER_MANIFEST_OPTION,
            wp_json_encode(hellas_launcher_default_manifest(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
        );
    }
    hellas_launcher_add_rewrite_rule();
    flush_rewrite_rules();
}
register_activation_hook(__FILE__, 'hellas_launcher_activate');

function hellas_launcher_deactivate(): void
{
    flush_rewrite_rules();
}
register_deactivation_hook(__FILE__, 'hellas_launcher_deactivate');
