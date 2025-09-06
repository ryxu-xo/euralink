class Plugin {
    constructor(name, options = {}) {
        if (!name) throw new Error('[Plugin] Plugin name is required');
        this.name = String(name);
        this.version = options.version || '0.0.0';
        this.enabled = options.enabled !== false;
    }

    // Optional hook: validate plugin compatibility
    validate(eura) {
        return true;
    }

    // Optional hook: called after validate, before load
    init(eura) {}

    load(eura) {
        if (eura && typeof eura.emit === 'function') {
            eura.emit('pluginLoaded', this);
        }
    }

    // Optional hook: cleanup resources
    unload(eura) {
        if (eura && typeof eura.emit === 'function') {
            eura.emit('pluginUnloaded', this);
        }
    }
}

module.exports = { Plugin };