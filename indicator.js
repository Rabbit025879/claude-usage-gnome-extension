import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ClawdIcon} from './clawdIcon.js';

const CREDENTIALS_PATH = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// Anthropic migrated the OAuth token endpoint from console.anthropic.com to
// platform.claude.com; try the new host first and fall back to the old one.
const TOKEN_URLS = [
    'https://platform.claude.com/v1/oauth/token',
    'https://console.anthropic.com/v1/oauth/token',
];
// Public client id used by the official `claude` CLI's OAuth login flow.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const POLL_INTERVAL_SECONDS = 300;
// Refresh a little before actual expiry so a poll never races the clock.
const TOKEN_REFRESH_BUFFER_SECONDS = 60;

// Text styles for different utilization tiers
const COLOR_NORMAL = 'color: #98c379;'; // Green
const COLOR_WARNING = 'color: #e5c07b;'; // Yellow
const COLOR_CRITICAL = 'color: #e06c75;'; // Red

function colorForUtilization(percent) {
    if (percent >= 90)
        return COLOR_CRITICAL;
    if (percent >= 75)
        return COLOR_WARNING;
    return COLOR_NORMAL;
}

// Generates a subtle, tech-style progress bar
function makeProgressBar(percent) {
    const totalBlocks = 10;
    const filledBlocks = Math.round((percent / 100) * totalBlocks);
    const emptyBlocks = totalBlocks - filledBlocks;
    return `[${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)}]`;
}

// Converts absolute timestamps into clean, relative, readable format
function formatRelativeResetTime(iso) {
    if (!iso)
        return '—';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return iso;

    const diffMs = date.getTime() - Date.now();
    if (diffMs <= 0)
        return 'any moment now';

    const diffMins = Math.round(diffMs / 60000);
    if (diffMins < 60)
        return `in ${diffMins}m`;

    const diffHours = Math.floor(diffMins / 60);
    const remainingMins = diffMins % 60;
    if (diffHours < 24)
        return `in ${diffHours}h ${remainingMins}m`;

    const diffDays = Math.round(diffHours / 24);
    return `in ${diffDays}d`;
}

export const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        // menuAlignment set to 0.5 to perfectly center the dropdown menu under the button
        super._init(0.5, 'Claude Usage', false);

        this._httpSession = new Soup.Session();
        // Some Anthropic hosts sit behind bot-detection that 403s requests
        // with no User-Agent at all; identify ourselves honestly.
        this._httpSession.user_agent = 'gnome-shell-extension-claude-usage/1.0';
        this._timeoutId = null;
        this._fetchInFlight = false;
        
        // Active state of the clawd animation (defaulting to enabled)
        this._animationEnabled = true;
        this._lastFiveHourPercent = 0;
        this._lastWeeklyPercent = 0;

        const box = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});

        this._clawd = new ClawdIcon(extensionPath);
        box.add_child(this._clawd);

        // Container for separating the 5h and 7d labels on the top panel
        this._labelBox = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._labelBox.set_style('padding: 0 6px;');

        // Label for 5-hour utilization on top panel
        this._label5h = new St.Label({
            text: '5h …',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._labelBox.add_child(this._label5h);

        // Divider label on top panel
        this._divider = new St.Label({
            text: ' · ',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._labelBox.add_child(this._divider);

        // Label for 7-day utilization on top panel
        this._label7d = new St.Label({
            text: '7d …',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._labelBox.add_child(this._label7d);

        box.add_child(this._labelBox);
        this.add_child(box);

        // Header/Title for the popup menu
        const headerItem = new PopupMenu.PopupMenuItem('CLAUDE PRO PLAN USAGE LIMITS', {reactive: false});
        headerItem.actor.set_style('font-weight: bold; font-size: 0.85em; opacity: 0.6; padding-bottom: 4px;');
        this.menu.addMenuItem(headerItem);

        // Build a highly customizable 5-Hour item with a layout box inside
        this._fiveHourItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._fiveHourLayout = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._fiveHourLayout.set_style('font-family: monospace;');
        
        this._fhTitle = new St.Label({text: '5-Hour: ', y_align: Clutter.ActorAlign.CENTER});
        this._fhBar = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._fhStats = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        
        this._fiveHourLayout.add_child(this._fhTitle);
        this._fiveHourLayout.add_child(this._fhBar);
        this._fiveHourLayout.add_child(this._fhStats);
        
        // Remove the default label and insert our custom container instead
        this._fiveHourItem.label.destroy();
        this._fiveHourItem.add_child(this._fiveHourLayout);
        this.menu.addMenuItem(this._fiveHourItem);

        // Build a highly customizable Weekly item with a layout box inside
        this._weeklyItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._weeklyLayout = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER});
        this._weeklyLayout.set_style('font-family: monospace;');
        
        this._wkTitle = new St.Label({text: 'Weekly: ', y_align: Clutter.ActorAlign.CENTER});
        this._wkBar = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._wkStats = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        
        this._weeklyLayout.add_child(this._wkTitle);
        this._weeklyLayout.add_child(this._wkBar);
        this._weeklyLayout.add_child(this._wkStats);
        
        // Remove the default label and insert our custom container instead
        this._weeklyItem.label.destroy();
        this._weeklyItem.add_child(this._weeklyLayout);
        this.menu.addMenuItem(this._weeklyItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Toggle switch for running clawd animation
        this._toggleAnimItem = new PopupMenu.PopupSwitchMenuItem('Run Clawd Animation', this._animationEnabled);
        this._toggleAnimItem.connect('toggled', (item, state) => {
            this._animationEnabled = state;
            this._updateClawdAnimation();
        });
        this.menu.addMenuItem(this._toggleAnimItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this._fetchUsage());
        this.menu.addMenuItem(refreshItem);

        this._fetchUsage();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
            this._fetchUsage();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _readCredentials() {
        try {
            const file = Gio.File.new_for_path(CREDENTIALS_PATH);
            const [ok, contents] = file.load_contents(null);
            if (!ok)
                return null;
            const text = new TextDecoder('utf-8').decode(contents);
            const json = JSON.parse(text);
            return json?.claudeAiOauth ?? null;
        } catch (e) {
            logError(e, 'claude-usage: failed to read credentials file');
            return null;
        }
    }

    // Writes the refreshed OAuth blob back to disk in the same shape the
    // `claude` CLI uses, keeping the file user-only readable.
    _writeCredentials(oauth) {
        try {
            const file = Gio.File.new_for_path(CREDENTIALS_PATH);
            const bytes = new TextEncoder().encode(JSON.stringify({claudeAiOauth: oauth}, null, 2));
            file.replace_contents(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            file.set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
            return true;
        } catch (e) {
            logError(e, 'claude-usage: failed to write credentials file');
            return false;
        }
    }

    // Exchanges the stored refresh token for a new access token, the same
    // way the `claude` CLI silently refreshes it when it runs. Tries each
    // known token endpoint in turn and persists the result on success.
    // onComplete is called with the new access token, or null on failure.
    _refreshAccessToken(oauth, onComplete) {
        if (!oauth?.refreshToken) {
            onComplete(null);
            return;
        }
        if (oauth.refreshTokenExpiresAt && oauth.refreshTokenExpiresAt <= Date.now()) {
            onComplete(null);
            return;
        }

        const requestBody = new TextEncoder().encode(JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: oauth.refreshToken,
            client_id: OAUTH_CLIENT_ID,
        }));

        const tryUrl = urlIndex => {
            if (urlIndex >= TOKEN_URLS.length) {
                onComplete(null);
                return;
            }

            const message = Soup.Message.new('POST', TOKEN_URLS[urlIndex]);
            if (!message) {
                tryUrl(urlIndex + 1);
                return;
            }
            message.set_request_body_from_bytes('application/json', GLib.Bytes.new(requestBody));

            this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                try {
                    // status_code avoids get_status()'s GEnum marshaling, which throws
                    // on codes Soup.Status doesn't define (e.g. 429 Too Many Requests).
                    if (message.status_code !== Soup.Status.OK) {
                        tryUrl(urlIndex + 1);
                        return;
                    }

                    const bytes = session.send_and_read_finish(result);
                    const text = new TextDecoder('utf-8').decode(bytes.get_data());
                    const data = JSON.parse(text);

                    const now = Date.now();
                    const newOauth = {
                        ...oauth,
                        accessToken: data.access_token,
                        refreshToken: data.refresh_token ?? oauth.refreshToken,
                        expiresAt: now + (data.expires_in ?? 0) * 1000,
                    };
                    // The endpoint returns a relative refresh_token_expires_in, not
                    // an absolute timestamp; only overwrite ours if it sent one.
                    if (typeof data.refresh_token_expires_in === 'number')
                        newOauth.refreshTokenExpiresAt = now + data.refresh_token_expires_in * 1000;
                    if (typeof data.scope === 'string')
                        newOauth.scopes = data.scope.split(' ');

                    if (!this._writeCredentials(newOauth)) {
                        onComplete(null);
                        return;
                    }
                    onComplete(newOauth.accessToken);
                } catch (e) {
                    logError(e, `claude-usage: token refresh against ${TOKEN_URLS[urlIndex]} failed`);
                    tryUrl(urlIndex + 1);
                }
            });
        };

        tryUrl(0);
    }

    // Handles fallback messages on system or request errors
    _setSystemStatus(text, style = '') {
        // Hide the separated indicators and display a single status message instead
        this._label5h.set_text(text);
        this._label5h.set_style(style);
        this._divider.hide();
        this._label7d.hide();
    }

    _fetchUsage() {
        if (this._fetchInFlight)
            return;

        if (!Gio.NetworkMonitor.get_default().get_network_available()) {
            this._setSystemStatus('Claude: no connection', COLOR_WARNING);
            return;
        }

        const oauth = this._readCredentials();
        if (!oauth?.accessToken && !oauth?.refreshToken) {
            this._setSystemStatus('Claude: no token');
            return;
        }

        const needsRefresh = !oauth.accessToken ||
            (oauth.expiresAt && oauth.expiresAt <= Date.now() + TOKEN_REFRESH_BUFFER_SECONDS * 1000);

        if (needsRefresh && oauth.refreshToken) {
            this._fetchInFlight = true;
            this._refreshAccessToken(oauth, newToken => {
                this._fetchInFlight = false;
                if (newToken)
                    this._fetchUsageWithToken(newToken, false);
                else if (oauth.accessToken)
                    this._fetchUsageWithToken(oauth.accessToken, true); // try the stale token as a last resort
                else
                    this._setSystemStatus('Claude: run `claude` to refresh', COLOR_WARNING);
            });
            return;
        }

        if (!oauth.accessToken) {
            this._setSystemStatus('Claude: run `claude` to refresh', COLOR_WARNING);
            return;
        }

        this._fetchUsageWithToken(oauth.accessToken, true);
    }

    // Performs the actual usage GET with a known-good-looking token. If the
    // server still rejects it with 401 and allowRefreshRetry is set, refresh
    // once and retry before giving up (covers tokens revoked out-of-band).
    _fetchUsageWithToken(token, allowRefreshRetry) {
        const message = Soup.Message.new('GET', USAGE_URL);
        if (!message) {
            this._setSystemStatus('Claude: bad request');
            return;
        }
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._fetchInFlight = true;
        this._httpSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            this._fetchInFlight = false;
            try {
                // status_code avoids get_status()'s GEnum marshaling, which throws
                // on codes Soup.Status doesn't define (e.g. 429 Too Many Requests).
                const status = message.status_code;
                if (status === 401) {
                    if (allowRefreshRetry) {
                        const oauth = this._readCredentials();
                        this._fetchInFlight = true;
                        this._refreshAccessToken(oauth, newToken => {
                            this._fetchInFlight = false;
                            if (newToken)
                                this._fetchUsageWithToken(newToken, false);
                            else
                                this._setSystemStatus('Claude: run `claude` to refresh', COLOR_WARNING);
                        });
                        return;
                    }
                    this._setSystemStatus('Claude: run `claude` to refresh', COLOR_WARNING);
                    return;
                }
                if (status !== Soup.Status.OK) {
                    this._setSystemStatus(`Claude: HTTP ${status}`, COLOR_WARNING);
                    return;
                }

                const bytes = session.send_and_read_finish(result);
                const text = new TextDecoder('utf-8').decode(bytes.get_data());
                const data = JSON.parse(text);
                this._render(data);
            } catch (e) {
                logError(e, 'claude-usage: fetch failed');
                if (!Gio.NetworkMonitor.get_default().get_network_available())
                    this._setSystemStatus('Claude: no connection', COLOR_WARNING);
                else
                    this._setSystemStatus('Claude: error', COLOR_WARNING);
            }
        });
    }

    _updateClawdAnimation() {
        if (this._animationEnabled) {
            // Restore mood/speed based on last saved usage (playing at 0% 5h,
            // sleeping at 100% either window, otherwise idle tiered by usage)
            this._clawd.setUsage(this._lastFiveHourPercent, this._lastWeeklyPercent);
        } else {
            this._clawd.pause();
        }
    }

    _render(data) {
        const fiveHour = data.five_hour ?? {};
        const weekly = data.seven_day ?? {};
        const fh = Math.round(fiveHour.utilization ?? 0);
        const wk = Math.round(weekly.utilization ?? 0);

        // Ensure the split layout is visible on top panel
        this._divider.show();
        this._label7d.show();

        // Update top panel labels (no style/color for panel text fallback, or keep subtle colored highlights)
        this._label5h.set_text(`5h ${fh}%`);
        this._label5h.set_style(colorForUtilization(fh));

        this._label7d.set_text(`7d ${wk}%`);
        this._label7d.set_style(colorForUtilization(wk));

        // Save current utilization percentages
        this._lastFiveHourPercent = fh;
        this._lastWeeklyPercent = wk;

        // Render clawd based on toggle state
        this._updateClawdAnimation();

        // Update custom styled menu items
        const pb5h = makeProgressBar(fh);
        const pb7d = makeProgressBar(wk);
        
        const reset5h = formatRelativeResetTime(fiveHour.resets_at);
        const reset7d = formatRelativeResetTime(weekly.resets_at);

        const color5h = colorForUtilization(fh);
        const color7d = colorForUtilization(wk);

        // 5-Hour dynamic updates
        this._fhBar.set_text(pb5h);
        this._fhBar.set_style(color5h); // Only the progress bar is colored!
        this._fhStats.set_text(` ${fh.toString().padStart(3, ' ')}% (${reset5h})`);

        // Weekly dynamic updates
        this._wkBar.set_text(pb7d);
        this._wkBar.set_style(color7d); // Only the progress bar is colored!
        this._wkStats.set_text(` ${wk.toString().padStart(3, ' ')}% (${reset7d})`);
    }

    stop() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }
});