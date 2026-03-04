import * as planck from 'planck-js';

export const PHYSICS_SCALE = 30; // pixels per meter

export interface BipedState {
    torsoAngle: number;
    leftHipAngle: number;
    leftKneeAngle: number;
    rightHipAngle: number;
    rightKneeAngle: number;
    headY: number;
    headX: number;
    leftFootContact: boolean;
    rightFootContact: boolean;
    velocityX: number;
}

export class BipedPhysics {
    public world: planck.World;
    private torso!: planck.Body;

    private leftHip!: planck.RevoluteJoint;
    private leftKnee!: planck.RevoluteJoint;
    private rightHip!: planck.RevoluteJoint;
    private rightKnee!: planck.RevoluteJoint;

    private leftFootContact = false;
    private rightFootContact = false;

    private timeStep = 1 / 60;
    private velocityIterations = 8;
    private positionIterations = 3;

    constructor() {
        // Standard gravity
        this.world = planck.World(planck.Vec2(0, -9.81));
        this.setupGround();
        this.setupBiped(0, 5); // start slightly above ground
        this.setupContactListener();
    }

    private setupGround() {
        const ground = this.world.createBody();

        // Create a very long floor
        ground.createFixture({
            shape: planck.Edge(planck.Vec2(-500.0, 0.0), planck.Vec2(500.0, 0.0)),
            friction: 0.8,
            restitution: 0.1,
        });
    }

    private setupBiped(startX: number, startY: number) {
        const filterGroup = -1; // Negative group index = these parts never collide with each other

        const torsoWidth = 0.5;
        const torsoHeight = 2.0;
        const thighWidth = 0.3;
        const thighHeight = 1.2;
        const calfWidth = 0.25;
        const calfHeight = 1.2;

        const density = 1.0;

        // --- Torso ---
        this.torso = this.world.createDynamicBody(planck.Vec2(startX, startY + thighHeight + calfHeight + torsoHeight / 2));
        this.torso.createFixture({
            shape: planck.Box(torsoWidth / 2, torsoHeight / 2),
            density: density * 2.0, // Torso is heavier
            friction: 0.5,
            filterGroupIndex: filterGroup,
        });

        // --- Legs ---
        const createLeg = (isLeft: boolean) => {
            const thigh = this.world.createDynamicBody(planck.Vec2(startX, startY + calfHeight + thighHeight / 2));
            thigh.createFixture({
                shape: planck.Box(thighWidth / 2, thighHeight / 2),
                density: density,
                friction: 0.5,
                filterGroupIndex: filterGroup,
            });

            const calf = this.world.createDynamicBody(planck.Vec2(startX, startY + calfHeight / 2));
            calf.createFixture({
                shape: planck.Box(calfWidth / 2, calfHeight / 2),
                userData: isLeft ? 'left_foot' : 'right_foot', // Identifier for contact listener
                density: density,
                friction: 0.8, // High friction feet
                filterGroupIndex: filterGroup,
            });

            // Hip Joint (Torso to Thigh)
            const hipJoint = planck.RevoluteJoint({
                enableLimit: true,
                lowerAngle: -Math.PI / 4, // limit forward swing
                upperAngle: Math.PI / 4,  // limit backward swing
                enableMotor: true,
                maxMotorTorque: 500.0,
                motorSpeed: 0.0,
            }, this.torso, thigh, planck.Vec2(startX, startY + calfHeight + thighHeight));
            this.world.createJoint(hipJoint);

            // Knee Joint (Thigh to Calf)
            const kneeJoint = planck.RevoluteJoint({
                enableLimit: true,
                lowerAngle: 0.0,         // Knees don't bend backwards
                upperAngle: Math.PI / 2, // limit bend
                enableMotor: true,
                maxMotorTorque: 300.0,
                motorSpeed: 0.0,
            }, thigh, calf, planck.Vec2(startX, startY + calfHeight));
            this.world.createJoint(kneeJoint);

            return { thigh, calf, hipJoint, kneeJoint };
        };

        const leftLeg = createLeg(true);
        this.leftHip = leftLeg.hipJoint;
        this.leftKnee = leftLeg.kneeJoint;

        const rightLeg = createLeg(false);
        this.rightHip = rightLeg.hipJoint;
        this.rightKnee = rightLeg.kneeJoint;
    }

    private setupContactListener() {
        this.world.on('begin-contact', (contact: planck.Contact) => {
            const fixtureA = contact.getFixtureA();
            const fixtureB = contact.getFixtureB();
            const userA = fixtureA.getUserData();
            const userB = fixtureB.getUserData();

            if (userA === 'left_foot' || userB === 'left_foot') this.leftFootContact = true;
            if (userA === 'right_foot' || userB === 'right_foot') this.rightFootContact = true;
        });

        this.world.on('end-contact', (contact: planck.Contact) => {
            const fixtureA = contact.getFixtureA();
            const fixtureB = contact.getFixtureB();
            const userA = fixtureA.getUserData();
            const userB = fixtureB.getUserData();

            // In real scenarios, multiple contacts could happen, but boolean is enough for our simple sensors
            if (userA === 'left_foot' || userB === 'left_foot') this.leftFootContact = false;
            if (userA === 'right_foot' || userB === 'right_foot') this.rightFootContact = false;
        });
    }

    public step(torques: number[]) {
        // apply torques [leftHip, leftKnee, rightHip, rightKnee]
        // Normalized [-1, 1] mapped to RPM speeds
        const maxSpeed = 10.0;

        // We treat the neural output as motor speed targets, and physics engine handles torque
        if (torques.length >= 4) {
            this.leftHip.setMotorSpeed(torques[0] * maxSpeed);
            this.leftKnee.setMotorSpeed(torques[1] * maxSpeed);
            this.rightHip.setMotorSpeed(torques[2] * maxSpeed);
            this.rightKnee.setMotorSpeed(torques[3] * maxSpeed);
        }

        this.world.step(this.timeStep, this.velocityIterations, this.positionIterations);
    }

    public getState(): BipedState {
        const headPos = this.torso.getPosition();
        return {
            torsoAngle: this.torso.getAngle(),
            leftHipAngle: this.leftHip.getJointAngle(),
            leftKneeAngle: this.leftKnee.getJointAngle(),
            rightHipAngle: this.rightHip.getJointAngle(),
            rightKneeAngle: this.rightKnee.getJointAngle(),
            headY: headPos.y,
            headX: headPos.x,
            leftFootContact: this.leftFootContact,
            rightFootContact: this.rightFootContact,
            velocityX: this.torso.getLinearVelocity().x,
        };
    }

    public getBodies(): planck.Body[] {
        let current = this.world.getBodyList();
        const bodies: planck.Body[] = [];
        while (current) {
            bodies.push(current);
            current = current.getNext();
        }
        return bodies;
    }
}
