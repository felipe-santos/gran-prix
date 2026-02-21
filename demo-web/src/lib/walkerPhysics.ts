/**
 * walkerPhysics.ts — Pure physics module for the Bipedal Walker demo.
 *
 * Uses planck-js for rigid-body 2D physics. Zero React dependencies.
 * Each walker consists of:
 *   - 1 torso (rectangle)
 *   - 2 upper legs
 *   - 2 lower legs
 *   - 4 revolute joints with motor control (left hip, left knee, right hip, right knee)
 *
 * The neural network reads 10 sensor values and writes 4 motor torques.
 */

import * as planck from 'planck-js';

// ── Physical constants ──────────────────────────────────────────────────────

/** Planck.js works best with bodies in the 0.1–10m range */
const TORSO_W = 0.4;
const TORSO_H = 0.8;
const UPPER_LEG_W = 0.16;
const UPPER_LEG_H = 0.50;
const LOWER_LEG_W = 0.14;
const LOWER_LEG_H = 0.50;

/** Maximum motor torque for joints (N·m in planck units) */
const MAX_TORQUE = 40;
/** Maximum motor speed (rad/s) */
const MAX_SPEED = 6;

/** Spawn height — must be high enough so legs don't clip ground */
const SPAWN_Y = 2.4;

/** Ground friction */
const GROUND_FRICTION = 0.9;
/** Feet (lower leg) friction — needs grip */
const FOOT_FRICTION = 1.5;

// ── Types ───────────────────────────────────────────────────────────────────

/** References to a single walker's physics bodies and joints */
export interface WalkerBody {
    torso: planck.Body;
    upperLegL: planck.Body;
    lowerLegL: planck.Body;
    upperLegR: planck.Body;
    lowerLegR: planck.Body;
    hipL: planck.RevoluteJoint;
    kneeL: planck.RevoluteJoint;
    hipR: planck.RevoluteJoint;
    kneeR: planck.RevoluteJoint;
    /** x-position at spawn, used to compute distance traveled */
    spawnX: number;
}

// ── Category bits for collision filtering ───────────────────────────────────

const CAT_GROUND = 0x0001;
const CAT_WALKER = 0x0002;

// ── World Creation ──────────────────────────────────────────────────────────

/**
 * Create the planck.js world with gravity and a flat ground plane.
 * The ground extends far enough (-50 to 150 metres) for walking demos.
 */
export function createWalkerWorld(): planck.World {
    const world = planck.World({ gravity: planck.Vec2(0, -10) });

    // Ground body — static
    const ground = world.createBody({
        type: 'static',
        position: planck.Vec2(0, 0),
    });

    // Long flat ground surface
    ground.createFixture({
        shape: planck.Edge(planck.Vec2(-50, 0), planck.Vec2(200, 0)),
        friction: GROUND_FRICTION,
        filterCategoryBits: CAT_GROUND,
        filterMaskBits: CAT_WALKER,
    });

    return world;
}

// ── Walker Body Creation ────────────────────────────────────────────────────

/**
 * Spawn one bipedal walker at position `spawnX` in the given world.
 * All body parts belong to the same collision group and do NOT collide with each other.
 * They only collide with the ground.
 *
 * @param world   - The planck.js world
 * @param spawnX  - Horizontal spawn position
 * @param groupIndex - Unique negative group index per walker (prevents self-collision)
 */
export function createWalkerBody(
    world: planck.World,
    spawnX: number,
    groupIndex: number,
): WalkerBody {
    const filterDef = {
        categoryBits: CAT_WALKER,
        maskBits: CAT_GROUND,
        groupIndex: -Math.abs(groupIndex + 1), // negative = never collide with same group
    };

    // ── Torso ───────────────────────────────────────────────────────────
    const torso = world.createDynamicBody({
        position: planck.Vec2(spawnX, SPAWN_Y),
        fixedRotation: false,
    });
    torso.createFixture({
        shape: planck.Box(TORSO_W / 2, TORSO_H / 2),
        density: 1.0,
        friction: 0.3,
        filterCategoryBits: filterDef.categoryBits,
        filterMaskBits: filterDef.maskBits,
        filterGroupIndex: filterDef.groupIndex,
    });

    // Helper: create a leg segment
    const createLeg = (
        parentBody: planck.Body,
        anchorLocal: planck.Vec2,
        width: number,
        height: number,
        friction: number,
    ): { body: planck.Body; joint: planck.RevoluteJoint } => {
        const parentPos = parentBody.getPosition();
        const worldAnchor = planck.Vec2(
            parentPos.x + anchorLocal.x,
            parentPos.y + anchorLocal.y,
        );
        const body = world.createDynamicBody({
            position: planck.Vec2(worldAnchor.x, worldAnchor.y - height / 2),
        });
        body.createFixture({
            shape: planck.Box(width / 2, height / 2),
            density: 1.0,
            friction,
            filterCategoryBits: filterDef.categoryBits,
            filterMaskBits: filterDef.maskBits,
            filterGroupIndex: filterDef.groupIndex,
        });

        const joint = world.createJoint(planck.RevoluteJoint(
            {
                enableMotor: true,
                maxMotorTorque: MAX_TORQUE,
                motorSpeed: 0,
                enableLimit: true,
                lowerAngle: -Math.PI * 0.5,
                upperAngle: Math.PI * 0.5,
            },
            parentBody,
            body,
            worldAnchor,
        ))! as planck.RevoluteJoint;

        return { body, joint };
    };

    // ── Left Leg ────────────────────────────────────────────────────────
    const { body: upperLegL, joint: hipL } = createLeg(
        torso,
        planck.Vec2(-TORSO_W / 4, -TORSO_H / 2),
        UPPER_LEG_W,
        UPPER_LEG_H,
        0.3,
    );
    const { body: lowerLegL, joint: kneeL } = createLeg(
        upperLegL,
        planck.Vec2(0, -UPPER_LEG_H / 2),
        LOWER_LEG_W,
        LOWER_LEG_H,
        FOOT_FRICTION,
    );

    // ── Right Leg ───────────────────────────────────────────────────────
    const { body: upperLegR, joint: hipR } = createLeg(
        torso,
        planck.Vec2(TORSO_W / 4, -TORSO_H / 2),
        UPPER_LEG_W,
        UPPER_LEG_H,
        0.3,
    );
    const { body: lowerLegR, joint: kneeR } = createLeg(
        upperLegR,
        planck.Vec2(0, -UPPER_LEG_H / 2),
        LOWER_LEG_W,
        LOWER_LEG_H,
        FOOT_FRICTION,
    );

    // Knee joint limits are more restrictive (knees don't bend backward)
    kneeL.setLimits(-Math.PI * 0.05, Math.PI * 0.7);
    kneeR.setLimits(-Math.PI * 0.05, Math.PI * 0.7);

    return {
        torso,
        upperLegL,
        lowerLegL,
        upperLegR,
        lowerLegR,
        hipL,
        kneeL,
        hipR,
        kneeR,
        spawnX,
    };
}

// ── Sensor Extraction (NN Inputs) ───────────────────────────────────────────

/**
 * Extract 10 normalized sensor values from a walker for the neural network.
 *
 * All values are clamped/normalized to approximately [-1, 1].
 */
export function getWalkerInputs(walker: WalkerBody): number[] {
    const torso = walker.torso;

    const bodyAngle = clamp(torso.getAngle() / Math.PI, -1, 1);
    const bodyAngVel = clamp(torso.getAngularVelocity() / 10, -1, 1);

    const hipLAngle = clamp(walker.hipL.getJointAngle() / (Math.PI * 0.5), -1, 1);
    const hipLVel = clamp(walker.hipL.getJointSpeed() / MAX_SPEED, -1, 1);
    const kneeLAngle = clamp(walker.kneeL.getJointAngle() / (Math.PI * 0.5), -1, 1);
    const kneeLVel = clamp(walker.kneeL.getJointSpeed() / MAX_SPEED, -1, 1);

    const hipRAngle = clamp(walker.hipR.getJointAngle() / (Math.PI * 0.5), -1, 1);
    const hipRVel = clamp(walker.hipR.getJointSpeed() / MAX_SPEED, -1, 1);
    const kneeRAngle = clamp(walker.kneeR.getJointAngle() / (Math.PI * 0.5), -1, 1);
    const kneeRVel = clamp(walker.kneeR.getJointSpeed() / MAX_SPEED, -1, 1);

    return [
        bodyAngle, bodyAngVel,
        hipLAngle, hipLVel, kneeLAngle, kneeLVel,
        hipRAngle, hipRVel, kneeRAngle, kneeRVel,
    ];
}

// ── Motor Control (NN Outputs) ──────────────────────────────────────────────

/**
 * Apply 4 NN outputs as motor speeds to the walker's joints.
 *
 * Each output is expected in [0, 1] (sigmoid from WASM). We map to [-MAX_SPEED, MAX_SPEED].
 */
export function applyWalkerOutputs(walker: WalkerBody, outputs: number[]): void {
    const mapToSpeed = (v: number) => (v * 2 - 1) * MAX_SPEED;

    walker.hipL.setMotorSpeed(mapToSpeed(outputs[0]));
    walker.kneeL.setMotorSpeed(mapToSpeed(outputs[1]));
    walker.hipR.setMotorSpeed(mapToSpeed(outputs[2]));
    walker.kneeR.setMotorSpeed(mapToSpeed(outputs[3]));
}

// ── Death Condition ─────────────────────────────────────────────────────────

/**
 * A walker is dead if its torso center drops below a threshold (fallen over).
 * We check torso Y and angle — extreme tilt means fallen.
 */
export function isWalkerDead(walker: WalkerBody): boolean {
    const pos = walker.torso.getPosition();
    const angle = Math.abs(walker.torso.getAngle());

    // Torso centre too low (practically on the ground)
    if (pos.y < 0.7) return true;

    // Extreme body tilt (> ~80°) — fallen sideways
    if (angle > Math.PI * 0.45) return true;

    return false;
}

// ── Distance Measurement ────────────────────────────────────────────────────

/** Horizontal distance traveled from spawn (positive = forward). */
export function getWalkerDistance(walker: WalkerBody): number {
    return walker.torso.getPosition().x - walker.spawnX;
}

// ── Fitness Calculation ─────────────────────────────────────────────────────

/**
 * Compute fitness for one walker at end-of-life or end-of-generation.
 *
 * Reward:
 *   - Horizontal distance traveled (primary goal)
 *   - Small survival bonus per frame
 *
 * Penalty:
 *   - Falling (death) — implicit via no more survival bonus
 */
export function computeWalkerFitness(
    walker: WalkerBody,
    framesAlive: number,
): number {
    const dist = getWalkerDistance(walker);
    // Distance is the primary reward; multiply to make it dominant
    const distReward = Math.max(0, dist) * 100;
    // Small survival bonus
    const survivalBonus = framesAlive * 0.1;

    return distReward + survivalBonus;
}

// ── Canvas Rendering ────────────────────────────────────────────────────────

/** Pixels per metre (planck units). Canvas scaling factor. */
export const PX_PER_METER = 80;

/**
 * Draw a single walker body as a stick figure on a canvas.
 *
 * @param ctx     - Canvas 2D context (already translated for camera)
 * @param walker  - The walker's physics bodies
 * @param color   - CSS colour for alive walkers
 * @param alpha   - Opacity (dim for dead agents)
 */
export function drawWalker(
    ctx: CanvasRenderingContext2D,
    walker: WalkerBody,
    color: string,
    alpha: number,
): void {
    ctx.save();
    ctx.globalAlpha = alpha;

    // Draw each body part as a filled rectangle
    const drawBody = (body: planck.Body, w: number, h: number, fill: string) => {
        const pos = body.getPosition();
        const angle = body.getAngle();
        const px = pos.x * PX_PER_METER;
        const py = -pos.y * PX_PER_METER; // flip Y (canvas Y is down, physics Y is up)

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(-angle); // flip rotation for canvas coords
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.roundRect(
            (-w / 2) * PX_PER_METER,
            (-h / 2) * PX_PER_METER,
            w * PX_PER_METER,
            h * PX_PER_METER,
            3,
        );
        ctx.fill();
        ctx.restore();
    };

    // Torso — slightly different shade
    drawBody(walker.torso, TORSO_W, TORSO_H, color);
    // Legs — slightly darker
    const legColor = adjustBrightness(color, -20);
    drawBody(walker.upperLegL, UPPER_LEG_W, UPPER_LEG_H, legColor);
    drawBody(walker.lowerLegL, LOWER_LEG_W, LOWER_LEG_H, legColor);
    drawBody(walker.upperLegR, UPPER_LEG_W, UPPER_LEG_H, legColor);
    drawBody(walker.lowerLegR, LOWER_LEG_W, LOWER_LEG_H, legColor);

    // Joint indicators — small circles at joint positions
    const drawJointDot = (joint: planck.RevoluteJoint) => {
        const anchor = joint.getAnchorA();
        ctx.beginPath();
        ctx.arc(
            anchor.x * PX_PER_METER,
            -anchor.y * PX_PER_METER,
            3,
            0,
            Math.PI * 2,
        );
        ctx.fillStyle = 'rgba(16, 185, 129, 0.7)';
        ctx.fill();
    };
    drawJointDot(walker.hipL);
    drawJointDot(walker.kneeL);
    drawJointDot(walker.hipR);
    drawJointDot(walker.kneeR);

    ctx.restore();
}

/**
 * Draw the ground plane.
 */
export function drawGround(
    ctx: CanvasRenderingContext2D,
    canvasWidth: number,
    groundY: number,
    isDark: boolean,
): void {
    ctx.fillStyle = isDark ? 'rgba(16, 185, 129, 0.15)' : 'rgba(16, 185, 129, 0.2)';
    ctx.fillRect(0, groundY, canvasWidth, 4);

    // Ground pattern — subtle hash marks
    ctx.strokeStyle = isDark ? 'rgba(16, 185, 129, 0.08)' : 'rgba(16, 185, 129, 0.12)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvasWidth; x += 20) {
        ctx.beginPath();
        ctx.moveTo(x, groundY + 4);
        ctx.lineTo(x + 10, groundY + 14);
        ctx.stroke();
    }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
}

/**
 * Simple brightness adjustment for HSL colors (our colors are HSL-based).
 * Falls back gracefully for non-HSL strings.
 */
function adjustBrightness(hslColor: string, delta: number): string {
    const match = hslColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
    if (!match) return hslColor;
    const h = parseInt(match[1]);
    const s = parseInt(match[2]);
    const l = clamp(parseInt(match[3]) + delta, 0, 100);
    return `hsl(${h}, ${s}%, ${l}%)`;
}

/**
 * Destroy all bodies belonging to a walker from the world.
 * Must be called outside of a physics step.
 */
export function destroyWalkerBody(world: planck.World, walker: WalkerBody): void {
    world.destroyBody(walker.lowerLegR);
    world.destroyBody(walker.upperLegR);
    world.destroyBody(walker.lowerLegL);
    world.destroyBody(walker.upperLegL);
    world.destroyBody(walker.torso);
}
