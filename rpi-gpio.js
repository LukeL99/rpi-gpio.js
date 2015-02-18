var fs = require('fs');
var exec = require('child_process').exec;
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var async = require('async');
var debug = require('debug')('rpi-gpio');
var Epoll = require('epoll').Epoll;

var PINS = {
    v1: {
        // 1: 3.3v
        // 2: 5v
        '3': 0,
        // 4: 5v
        '5': 1,
        // 6: ground
        '7': 4,
        '8': 14,
        // 9: ground
        '10': 15,
        '11': 17,
        '12': 18,
        '13': 21,
        // 14: ground
        '15': 22,
        '16': 23,
        // 17: 3.3v
        '18': 24,
        '19': 10,
        // 20: ground
        '21': 9,
        '22': 25,
        '23': 11,
        '24': 8,
        // 25: ground
        '26': 7
    },
    v2: {
        // 1: 3.3v
        // 2: 5v
        '3': 2,
        // 4: 5v
        '5': 3,
        // 6: ground
        '7': 4,
        '8': 14,
        // 9: ground
        '10': 15,
        '11': 17,
        '12': 18,
        '13': 27,
        // 14: ground
        '15': 22,
        '16': 23,
        // 17: 3.3v
        '18': 24,
        '19': 10,
        // 20: ground
        '21': 9,
        '22': 25,
        '23': 11,
        '24': 8,
        // 25: ground
        '26': 7,

        // Model B+ pins
        // 27: ID_SD
        // 28: ID_SC
        '29': 5,
        // 30: ground
        '31': 6,
        '32': 12,
        '33': 13,
        // 34: ground
        '35': 19,
        '36': 16,
        '37': 26,
        '38': 20,
        // 39: ground
        '40': 21
    }
};

// OPTIONS:
// gpioAdmin: true|false - whether to use gpioAdmin or not. If not, must be run as root.
// mode: 'BCM'|'RPI' - Sets pin numbering scheme. Defaults to RPI;
function Gpio(options) {

    options = options || {};

    var currentPins;
    var exportedInputPins = {};
    var exportedOutputPins = {};
    var poller;

    var getPin;
    if(options.mode && options.mode == 'BCM'){
        debug('Setting mode to BCM.');
        getPin = getPinBcm;
    } else {
        debug('Setting mode to RPI.');
        getPin = getPinRpi;
    }
    var path = options.gpioAdmin === true ? '/sys/devices/virtual/gpio' : '/sys/class/gpio';

    this.DIR_IN = 'in';
    this.DIR_OUT = 'out';
    this.PULL_UP = 'pullup';
    this.PULL_DOWN = 'pulldown';
    this.MODE_RPI = 'mode_rpi';
    this.MODE_BCM = 'mode_bcm';

    /**
     * Setup a channel for use as an input or output
     *
     * @param {number}   channel   Reference to the pin in the current mode's schema
     * @param {string}   direction The pin direction, either 'in' or 'out'
     * @param {string}   pullupdown Optional whether to enable pull up or down resistors, either 'pullup' or 'pulldown'.
     * Currently only available in gpio-admin.
     * @param {function} onSetup   Optional callback
     */
    /*
    setup(channel, onSetup)
    setup(channel, direction, onSetup)
    setup(channel, direction, pullupdown, onSetup)
     */
    this.setup = function(channel, direction, pullupdown, onSetup /*err*/) {
        if (arguments.length === 2 && typeof direction == 'function') {
            onSetup = direction;
            direction = this.DIR_OUT;
        }

        if (arguments.length === 3 && typeof pullupdown == 'function') {
            onSetup = pullupdown;
            pullupdown = null;
        }

        direction = direction || this.DIR_OUT;
        onSetup = onSetup || function() {};

        if (!channel) {
            return process.nextTick(function() {
                onSetup(new Error('Channel must be a number'));
            });
        }

        if (direction !== this.DIR_IN && direction !== this.DIR_OUT) {
            return process.nextTick(function() {
                onSetup(new Error('Cannot set invalid direction'));
            });
        }

        if (pullupdown !== this.PULL_UP && pullupdown !== this.PULL_DOWN
            && pullupdown !== null && pullupdown !== undefined) {
            return process.nextTick(function() {
                onSetup(new Error('Cannot set invalid pullup/pulldown value'));
            });
        }

        var pinForSetup;
        async.waterfall([
            setRaspberryVersion,
            function(next) {
                pinForSetup = getPin(channel);
                if (!pinForSetup) {
                    return next(new Error('Channel ' + channel + ' does not map to a GPIO pin'));
                }
                debug('set up pin %d', pinForSetup);
                isExported(pinForSetup, next);
            },
            function(isExported, next) {
                if (isExported) {
                    return unexportPin(pinForSetup, next);
                }
                return next(null);
            },
            function(next) {
                exportPin(pinForSetup, pullupdown, next);
            },
            function(next) {
                this.emit('export', channel);
                createListener.call(this, channel, pinForSetup);

                if (direction === this.DIR_IN) {
                    exportedInputPins[pinForSetup] = true;
                } else {
                    exportedOutputPins[pinForSetup] = true;
                }

                setDirection(pinForSetup, direction, next);
            }.bind(this)
        ], onSetup);
    };

    /**
     * Write a value to a channel
     *
     * @param {number}   channel The channel to write to
     * @param {boolean}  value   If true, turns the channel on, else turns off
     * @param {function} cb      Optional callback
     */
    this.write = this.output = function(channel, value, cb /*err*/) {
        var pin = getPin(channel);

        if (!exportedOutputPins[pin]) {
            var message;
            if (exportedInputPins[pin]) {
                message = 'Pin has been exported for input so cannot be written to';
            } else {
                message = 'Pin has not been exported';
            }

            return process.nextTick(function() {
                cb(new Error(message));
            });
        }

        value = (!!value && value !== '0') ? '1' : '0';
        fs.writeFile(path + '/gpio' + pin + '/value', value, cb || function() {});
    };

    /**
     * Read a value from a channel
     *
     * @param {number}   channel The channel to read from
     * @param {function} cb      Callback which receives the channel's boolean value
     */
    this.read = this.input = function(channel, cb /*err,value*/) {
        var pin = getPin(channel);

        if (!exportedInputPins[pin]) {
            return process.nextTick(function() {
                cb(new Error('Pin has not been exported'));
            });
        }

        var buffer = new Buffer(1);
        var fd = fs.openSync(path + '/gpio' + pin + '/value', 'r');
        fs.read(fd, buffer, 0, 1, 0, function(err, bytesRead, buffer) {
            return cb(err, buffer.toString() === '1');
        });
    };

    /**
     * Unexport any pins setup by this module
     *
     * @param {function} cb Optional callback
     */
    this.destroy = function(cb) {
        if(poller){
            poller.close();
        }
        var tasks = Object.keys(exportedOutputPins)
            .concat(Object.keys(exportedInputPins))
            .map(function(pin) {
                return function(done) {
                    unexportPin(pin, done);
                }
            });

        async.parallel(tasks, cb);
    };

    /**
     * Reset the state of the module
     */
    this.reset = function() {
        exportedOutputPins = {};
        exportedInputPins = {};
        this.removeAllListeners();

        currentPins = undefined;
        getPin = getPinRpi;
    };

    // Init
    EventEmitter.call(this);
    this.reset();


    // Private functions requring access to state
    function setRaspberryVersion(cb) {
        if (currentPins) {
            return cb(null);
        }

        fs.readFile('/proc/cpuinfo', 'utf8', function(err, data) {
            if (err) {return cb(err);}

            // Match the last 4 digits of the number following "Revision:"
            var match = data.match(/Revision\s*:\s*[0-9a-f]*([0-9a-f]{4})/);
            var revisionNumber = parseInt(match[1], 16);
            var pinVersion = (revisionNumber < 4) ? 'v1' : 'v2';

            debug(
                'seen hardware revision %d; using pin mode %s',
                revisionNumber,
                pinVersion
            );

            currentPins = PINS[pinVersion];

            return cb(null);
        });
    };

    function getPinRpi(channel) {
        return currentPins[channel] + '';
    };

    function getPinBcm(channel) {
        channel = parseInt(channel, 10);
        return [
            3,
            5,
            7,
            8,
            10,
            11,
            12,
            13,
            15,
            16,
            18,
            19,
            21,
            22,
            23,
            24,
            26,
            29,
            31,
            32,
            33,
            35,
            36,
            37,
            38,
            40
        ].indexOf(channel) !== -1 ? (channel + '') : null;
    };

    function createListener(channel, pin) {
        debug('listen for pin %d', pin);
        var Gpio = this;

        // only initialize poller on first use
        if(!poller){
            poller = new Epoll(function (err, fd, events) {
                // Read GPIO value file. Reading also clears the interrupt.
                Gpio.read(channel, function(err, value){
                    Gpio.emit('change', channel, value);
                });
            });
        }

        var fd = fs.openSync(path + '/gpio' + pin + '/value', 'r');

        // Read the GPIO value file before watching to prevent an initial unauthentic interrupt.
        fs.readSync(fd, new Buffer(1), 0, 1, 0);

        // Start watching for interrupts.
        poller.add(fd, Epoll.EPOLLPRI);
    };

    var baseCommand = 'gpio-admin';

    function setDirection(pin, direction, cb) {
        debug('set direction %s on pin %d', direction.toUpperCase(), pin);
        fs.writeFile(path + '/gpio' + pin + '/direction', direction, function(err) {
            if (cb) {
                return cb(err);
            }
        });
    }

    function exportPin(pin, pullupdown, cb) {
        debug('export pin %d with pullup/down mode %s', pin, pullupdown);
        if (options.gpioAdmin) {
            if(pullupdown){
                execCommand(baseCommand + ' export ' + pin + ' ' + pullupdown, cb);
            } else {
                execCommand(baseCommand + ' export ' + pin, cb);
            }
        } else {
            fs.writeFile(path + '/export', pin, cb);
        }
    }

    function unexportPin(pin, cb) {
        debug('unexport pin %d', pin);
        var fd = fs.openSync(path + '/gpio' + pin + '/value', 'r');
        poller.remove(fd);
        if (options.gpioAdmin) {
            execCommand(baseCommand + ' unexport ' + pin, cb);
        } else {
            fs.writeFile(path + '/unexport', pin, cb);
        }
    }

    function isExported(pin, cb) {
        fs.exists(path + '/gpio' + pin, function(exists) {
            return cb(null, exists);
        });
    }

}
util.inherits(Gpio, EventEmitter);

function execCommand(command, cb) {

    exec(command,
        function(error, stdout, stderr) {
            if (error) {
                debug('command: ' + command);
                debug('exec error: ' + error);
                debug('stderr: ' + stderr);
                debug('stdout: ' + stdout);
            }
            return cb(error);
        });
}

module.exports = new Gpio;