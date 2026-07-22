import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import cairo from 'gi://cairo';

const FRAME_COUNT = 12;
const FRAME_SIZE = 64; // clawd-assets/frames/<mood>/<size>/ — matches ICON_SIZE at 2x for HiDPI crispness
const ICON_SIZE = 50;

const MOOD_IDLE = 'idle';
const MOOD_PLAY = 'play';
const MOOD_SLEEP = 'sleep';
const MOODS = [MOOD_IDLE, MOOD_PLAY, MOOD_SLEEP];

const IDLE_MAX_PERCENT = 30;
const TROT_MAX_PERCENT = 70;

const IDLE_INTERVAL_MS = {
    idle: 220,
    trot: 110,
    sprint: 60,
};
// Fixed loop speeds baked into the play/sleep frame sets by gen2.py.
const PLAY_INTERVAL_MS = 90;
const SLEEP_INTERVAL_MS = 180;

function moodFor(fiveHourPercent, weeklyPercent) {
    if (fiveHourPercent >= 100 || weeklyPercent >= 100)
        return MOOD_SLEEP;
    if (fiveHourPercent <= 0)
        return MOOD_PLAY;
    return MOOD_IDLE;
}

function idleIntervalForPercent(percent) {
    if (percent <= IDLE_MAX_PERCENT)
        return IDLE_INTERVAL_MS.idle;
    if (percent <= TROT_MAX_PERCENT)
        return IDLE_INTERVAL_MS.trot;
    return IDLE_INTERVAL_MS.sprint;
}

export const ClawdIcon = GObject.registerClass(
class ClawdIcon extends St.DrawingArea {
    _init(extensionPath) {
        super._init({
            style_class: 'system-status-icon',
            reactive: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.set_size(ICON_SIZE, ICON_SIZE);

        // Pre-load surfaces for every mood
        this._surfaces = {};
        for (const mood of MOODS)
            this._surfaces[mood] = this._loadFrames(extensionPath, mood);

        this._mood = MOOD_IDLE;
        this._frameIndex = 0;
        this._timeoutId = null;
        this._currentInterval = null;

        this.connect('repaint', area => this._onRepaint(area));

        // Ensure proper cleanup on destroy to avoid memory leaks
        this.connect('destroy', () => {
            this._stopTimer();
            this._cleanupSurfaces();
        });

        // Boots frozen on the idle pose (no running timer) until real usage data arrives.
    }

    _loadFrames(extensionPath, mood) {
        const surfaces = [];
        for (let i = 0; i < FRAME_COUNT; i++) {
            const n = i.toString().padStart(2, '0');
            const path = GLib.build_filenamev(
                [extensionPath, 'clawd-assets', 'frames', mood, `${FRAME_SIZE}`, `clawd-${n}.png`]);
            surfaces.push(cairo.ImageSurface.createFromPNG(path));
        }
        return surfaces;
    }

    // fiveHourPercent/weeklyPercent are rounded utilization percentages (0-100+).
    // Playing at 0% five-hour usage and sleeping at 100% (either window) take
    // priority over the usage-tiered idle trot/sprint animation.
    setUsage(fiveHourPercent, weeklyPercent) {
        const mood = moodFor(fiveHourPercent, weeklyPercent);
        const interval = mood === MOOD_SLEEP ? SLEEP_INTERVAL_MS :
            mood === MOOD_PLAY ? PLAY_INTERVAL_MS :
            idleIntervalForPercent(Math.max(fiveHourPercent, weeklyPercent));

        if (mood !== this._mood) {
            this._mood = mood;
            this._frameIndex = 0;
            this.queue_repaint();
        }
        this._startTimer(interval);
    }

    // Stops the timer and freezes on the idle pose (used when animation is toggled off).
    pause() {
        this._stopTimer();
        this._currentInterval = null;
        this._mood = MOOD_IDLE;
        if (this._frameIndex !== 0) {
            this._frameIndex = 0;
            this.queue_repaint();
        }
    }

    _startTimer(interval) {
        if (this._currentInterval === interval)
            return;
        this._stopTimer();
        this._currentInterval = interval;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._frameIndex = (this._frameIndex + 1) % FRAME_COUNT;
            this.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    _cleanupSurfaces() {
        if (this._surfaces) {
            for (const mood of MOODS) {
                for (const surface of this._surfaces[mood] ?? []) {
                    if (surface && typeof surface.$dispose === 'function') {
                        surface.$dispose();
                    }
                }
            }
            this._surfaces = {};
        }
    }

    _onRepaint(area) {
        const cr = area.get_context();
        const [surfaceWidth, surfaceHeight] = area.get_surface_size();
        const image = this._surfaces[this._mood]?.[this._frameIndex];

        if (!image) {
            cr.$dispose();
            return;
        }

        // Get resource scale for HiDPI/Retina display support
        const resourceScale = this.get_resource_scale();
        const imgWidth = image.getWidth() / resourceScale;
        const imgHeight = image.getHeight() / resourceScale;

        // Calculate scaling factor safely
        const scaleX = surfaceWidth / imgWidth;
        const scaleY = surfaceHeight / imgHeight;
        const scale = Math.min(scaleX, scaleY);

        // Center and scale the drawing context
        cr.translate(
            (surfaceWidth - imgWidth * scale) / 2,
            (surfaceHeight - imgHeight * scale) / 2
        );
        cr.scale(scale, scale);

        // Paint clawd in its own brand color (clay-orange body, white eyes) —
        // unlike a symbolic mask, this preserves the eye cutouts as a visible detail.
        cr.setSourceSurface(image, 0, 0);
        cr.paint();
        cr.$dispose();
    }
});
