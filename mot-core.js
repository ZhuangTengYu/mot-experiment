/* MOT experiment core: no browser DOM or third-party dependencies.
 *
 * Coordinates: pixels, origin at arena centre, positive y upward.
 * Speeds: pixels/second. Radius, arena dimensions and fixedDt are logical
 * pixels/seconds and must not be changed by CSS or devicePixelRatio scaling.
 *
 * Randomness uses Mulberry32 (32-bit seed, version mulberry32-v1). Reusing a
 * seed reproduces the JS scene/schedule. This is deliberately not Python's
 * Mersenne Twister: browser and PsychoPy seed streams must not be equated.
 * Physics ports code/mot_core.py's event-driven equal-mass elastic solver.
 */
(function attachMOTCore(root) {
  "use strict";

  const TARGET_COUNTS = Object.freeze([3, 4, 5, 6]);
  const N_OBJECTS = 8;
  const PRNG_ALGORITHM = "mulberry32-v1";
  const EPS = 1e-9;

  function createRng(seed) {
    if (!Number.isSafeInteger(seed)) {
      throw new RangeError("Seed must be a safe integer.");
    }
    let state = seed >>> 0;
    return function nextRandom() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(values, rng) {
    for (let i = values.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [values[i], values[j]] = [values[j], values[i]];
    }
    return values;
  }

  function buildSchedule(seed, trialsPerLoad = 10, practiceTrials = 4) {
    if (!Number.isInteger(trialsPerLoad) || trialsPerLoad < 1 ||
        !Number.isInteger(practiceTrials) || practiceTrials < 0) {
      throw new RangeError("Formal trial counts must be positive integers; practice may be zero.");
    }
    const rng = createRng(seed);
    const practice = Array.from({ length: practiceTrials }, (_, i) => TARGET_COUNTS[i % 4]);
    const formal = TARGET_COUNTS.flatMap((k) => Array(trialsPerLoad).fill(k));
    shuffle(practice, rng);
    shuffle(formal, rng);
    const schedule = [];
    for (const [phase, loads] of [["practice", practice], ["formal", formal]]) {
      loads.forEach((k, index) => {
        schedule.push({ phase, trial_index: index + 1, target_count: k,
          trial_seed: Math.floor(rng() * 2147483648) });
      });
    }
    return schedule;
  }

  function scoreSelection(targets, selections) {
    if (!Array.isArray(targets) || !Array.isArray(selections)) {
      throw new TypeError("Targets and selections must be arrays of ball identities.");
    }
    const targetSet = new Set(targets);
    const selectedSet = new Set(selections);
    if (targetSet.size === 0) {
      throw new RangeError("At least one target is required.");
    }
    if (targetSet.size !== targets.length || selectedSet.size !== selections.length) {
      throw new RangeError("Duplicate ball identities are not valid.");
    }
    if (targetSet.size !== selectedSet.size) {
      throw new RangeError("Select exactly as many balls as there are targets.");
    }
    if (![...targets, ...selections].every((i) => Number.isInteger(i) && i >= 0 && i < N_OBJECTS)) {
      throw new RangeError("Ball identities must be integers between 0 and 7.");
    }
    const hits = targets.filter((i) => selectedSet.has(i)).length;
    return { hits, accuracy: hits / targets.length, exact: Number(hits === targets.length) };
  }

  function geometry(options = {}) {
    const { radius = 18, width = 1000, height = 560, fixedDt = 1 / 240 } = options;
    if (![radius, width, height, fixedDt].every(Number.isFinite) ||
        radius <= 0 || width <= 2 * radius || height <= 2 * radius || fixedDt <= 0) {
      throw new RangeError("Invalid arena geometry or integration step.");
    }
    return { radius, width, height, fixedDt };
  }

  class ElasticWorld {
    constructor(positions, velocities, options = {}) {
      const { radius, width, height, fixedDt } = geometry(options);
      if (!Array.isArray(positions) || !Array.isArray(velocities) ||
          positions.length === 0 || positions.length !== velocities.length) {
        throw new RangeError("One velocity is required for each ball.");
      }
      for (const vectors of [positions, velocities]) {
        if (!vectors.every((v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite))) {
          throw new TypeError("Positions and velocities must be finite two-dimensional vectors.");
        }
      }
      // Never share vectors with caller-owned scene definitions.
      this.positions = positions.map((p) => [...p]);
      this.velocities = velocities.map((v) => [...v]);
      this.radius = radius;
      this.width = width;
      this.height = height;
      this.fixedDt = fixedDt;
      this.xmax = width / 2 - radius;
      this.ymax = height / 2 - radius;
      this.collisions = 0;
      this.elapsed = 0;
      this.validate();
    }

    static random(seed, speed = 160, options = {}) {
      if (!Number.isFinite(speed) || speed < 80 || speed > 260) {
        throw new RangeError("Initial speed must be between 80 and 260 pixels/second.");
      }
      const params = geometry(options);
      const { radius, width, height } = params;
      if (width <= 2 * radius + 16 || height <= 2 * radius + 16) {
        throw new RangeError("Random scenes require room for the initial wall clearance.");
      }
      const rng = createRng(seed);
      const positions = [];
      for (let i = 0; i < N_OBJECTS; i += 1) {
        let placed = false;
        for (let attempt = 0; attempt < 10000; attempt += 1) {
          const p = [
            -width / 2 + radius + 8 + rng() * (width - 2 * radius - 16),
            -height / 2 + radius + 8 + rng() * (height - 2 * radius - 16),
          ];
          if (positions.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= 2 * radius + 12)) {
            positions.push(p);
            placed = true;
            break;
          }
        }
        if (!placed) {
          throw new RangeError("Could not place balls without overlap.");
        }
      }
      const velocities = positions.map(() => {
        const theta = rng() * 2 * Math.PI;
        return [speed * Math.cos(theta), speed * Math.sin(theta)];
      });
      return new ElasticWorld(positions, velocities, params);
    }

    energy() {
      return this.velocities.reduce((sum, v) => sum + v[0] * v[0] + v[1] * v[1], 0) / 2;
    }

    momentum() {
      return [0, 1].map((axis) => this.velocities.reduce((sum, v) => sum + v[axis], 0));
    }

    validate(tolerance = 1e-6) {
      if (!Number.isFinite(tolerance) || tolerance < 0) {
        throw new RangeError("Validation tolerance must be finite and nonnegative.");
      }
      for (let i = 0; i < this.positions.length; i += 1) {
        const p = this.positions[i];
        if (!p.every(Number.isFinite) || !this.velocities[i].every(Number.isFinite)) {
          throw new Error("Non-finite position or velocity.");
        }
        if (Math.abs(p[0]) > this.xmax + tolerance || Math.abs(p[1]) > this.ymax + tolerance) {
          throw new Error("A ball crossed an arena wall.");
        }
        for (let j = i + 1; j < this.positions.length; j += 1) {
          const q = this.positions[j];
          if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 2 * this.radius - tolerance) {
            throw new Error("Balls overlap.");
          }
        }
      }
      return true;
    }

    advance(seconds) {
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new RangeError("Elapsed time must be finite and nonnegative.");
      }
      let remaining = seconds;
      while (remaining > EPS) {
        const step = Math.min(remaining, this.fixedDt);
        this._advanceEvents(step);
        remaining -= step;
      }
      this.elapsed += seconds;
    }

    _advanceEvents(duration) {
      let remaining = duration;
      for (let iteration = 0; iteration < 4096; iteration += 1) {
        if (remaining <= EPS) return;
        let earliest = remaining + 1;
        let events = [];
        const candidate = (time, event) => {
          if (time >= -EPS && time <= remaining + EPS) {
            const t = Math.max(0, Math.min(time, remaining));
            if (t < earliest - EPS) {
              earliest = t;
              events = [event];
            } else if (Math.abs(t - earliest) <= EPS) {
              events.push(event);
            }
          }
        };

        for (let i = 0; i < this.positions.length; i += 1) {
          const p = this.positions[i];
          const v = this.velocities[i];
          for (const [axis, limit] of [[0, this.xmax], [1, this.ymax]]) {
            if (v[axis] > EPS) {
              candidate((limit - p[axis]) / v[axis], ["wall", i, axis, limit]);
            } else if (v[axis] < -EPS) {
              candidate((-limit - p[axis]) / v[axis], ["wall", i, axis, -limit]);
            }
          }
          for (let j = i + 1; j < this.positions.length; j += 1) {
            const q = this.positions[j];
            const u = this.velocities[j];
            const dx = q[0] - p[0];
            const dy = q[1] - p[1];
            const vx = u[0] - v[0];
            const vy = u[1] - v[1];
            const a = vx * vx + vy * vy;
            const b = dx * vx + dy * vy;
            const c = dx * dx + dy * dy - (2 * this.radius) ** 2;
            if (a > EPS && b < -EPS) {
              const discriminant = b * b - a * c;
              if (discriminant >= 0) {
                // Stable earlier root of the squared separation equation.
                const t = c > 0 ? c / (-b + Math.sqrt(discriminant)) : 0;
                candidate(t, ["pair", i, j]);
              }
            }
          }
        }

        const travel = events.length ? earliest : remaining;
        for (let i = 0; i < this.positions.length; i += 1) {
          this.positions[i][0] += this.velocities[i][0] * travel;
          this.positions[i][1] += this.velocities[i][1] * travel;
        }
        remaining -= travel;
        if (!events.length) return;

        for (const event of events) {
          if (event[0] === "wall") {
            const [, i, axis, limit] = event;
            this.positions[i][axis] = limit;
            if (this.velocities[i][axis] * limit > 0) {
              this.velocities[i][axis] *= -1;
              this.collisions += 1;
            }
          } else {
            const [, i, j] = event;
            const p = this.positions[i];
            const q = this.positions[j];
            const v = this.velocities[i];
            const u = this.velocities[j];
            const dx = q[0] - p[0];
            const dy = q[1] - p[1];
            const norm = Math.hypot(dx, dy);
            const nx = dx / norm;
            const ny = dy / norm;
            const relative = (u[0] - v[0]) * nx + (u[1] - v[1]) * ny;
            if (relative < -EPS) {
              // Exchange only normal velocity; never normalize each speed.
              v[0] += relative * nx;
              v[1] += relative * ny;
              u[0] -= relative * nx;
              u[1] -= relative * ny;
              this.collisions += 1;
            }
          }
        }
      }
      throw new Error("Collision solver exceeded its event limit.");
    }
  }

  const api = Object.freeze({ TARGET_COUNTS, N_OBJECTS, PRNG_ALGORITHM, createRng,
    buildSchedule, scoreSelection, ElasticWorld });
  root.MOTCore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
