// The shell's procedural audio layer.
//
// Four closed cues, matching `ala-cities/src/audio.rs`: select, place, refuse,
// notify. The samples are rendered by `tools/gen_shell_audio.py` and compiled into
// this addon as Deadlock soundevents; Panorama can only play a named event, so it
// cannot synthesize the waveform at runtime. The event table below is the source of
// truth the generator checks against.
//
// A missing PlayUISoundEvent is not an error: a reduced or headless client build can
// lack the UI runtime, and a silent shell is better than a refused layout. The last
// attempt is exposed through OpenlockAudioStatus() for the settings/probe surfaces.
(function () {
    var EVENTS = {
        select: "Openlock.UI.Select",
        place: "Openlock.UI.Place",
        refuse: "Openlock.UI.Refuse",
        notify: "Openlock.UI.Notify"
    };
    var THROTTLE_MS = 40;
    var lastAt = {};
    var state = "idle";
    var plays = 0;

    function play(name) {
        var event = EVENTS[name];
        if (!event) {
            state = "unknown cue '" + name + "'";
            return "";
        }

        // A click can arrive twice (press and activate); one cue per 40 ms keeps the
        // feedback from stacking while still allowing a normal double action.
        var now = Date.now();
        if (now - (lastAt[name] || 0) < THROTTLE_MS) return event;
        lastAt[name] = now;

        try {
            if (typeof PlayUISoundEvent !== "function") {
                state = "PlayUISoundEvent absent";
                return event;
            }
            PlayUISoundEvent(event);
            state = "played " + event;
            plays++;
            return event;
        } catch (e) {
            state = "refused " + event + ": " + String(e);
            return event;
        }
    }

    globalThis.OpenlockCue = function (name) {
        return play(String(name || "").toLowerCase());
    };

    globalThis.OpenlockAudioStatus = function () {
        return {
            available: (typeof PlayUISoundEvent === "function"),
            state: state,
            plays: plays,
            events: EVENTS
        };
    };
})();
