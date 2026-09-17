/*
 * Exports:
 * - LoaderAnimator: browser animation boundary for loader targets.
 * - LoaderMotion: weighted animation sequence consumed by the controller.
 * - default LoaderAnimationController: owns loader motion sequencing and disposal.
 */
export type LoaderAnimator = (target: "spin" | "brake" | "jitter" | "traveller" | number | { rotation: number } | { selfRotation: number }, frames: Keyframe[], options: KeyframeAnimationOptions) => Pick<Animation, "finished" | "cancel">;

type Track = { target: Exclude<Parameters<LoaderAnimator>[0], "spin">; frames: Keyframe[]; easing?: string };
export type LoaderMotion = { weight: number; duration: number; tracks: () => Track[] };
const ease = "cubic-bezier(.4,0,.2,1)";
const directions = [[0, 1], [-.7075, .7075], [-1, 0], [-.7075, -.7075], [0, -1], [.7075, -.7075], [1, 0], [.7075, .7075]];
const foldStarts = [0, 43.2, 88.3, 137.2, 193.7, 264.3, 362.6, 526.7];
const bounceStarts = [0, 315, 445, 550, 650, 755, 885, 1200];
const collectorTimes = [[0, 1], [.175615, .536372], [.246039, .5735], [.300082, .612255], [.346203, .653797], [.387745, .699918], [.4265, .753961], [.463628, .824385]];

function foldTracks(duration: number, times: (index: number) => number[]): Track[] {
  return directions.map(([x, y], target) => {
    const [start, hidden, restore, visible] = times(target);
    const rest = { opacity: 1, transform: "translate(0px,0px)" };
    const folded = { opacity: 0, transform: `translate(${x! * .8}px,${y! * .8}px)` };
    return { target, frames: [
      { ...rest, offset: 0 },
      { ...rest, offset: start! / duration, easing: ease },
      { ...folded, offset: hidden! / duration },
      { ...folded, offset: restore! / duration, easing: ease },
      { ...rest, offset: visible! / duration },
      { ...rest, offset: 1 },
    ] };
  });
}

const glitchCircuits = [
  {
    spokes: [0, 3, 6],
    shifts: [[0, 0], [1.15, -.35], [1.15, -.35], [-.45, .2], [0, 0], [0, 0], [-.9, .5], [-.9, .5], [0, 0], [0, 0]],
    shiftTimes: [0, .08, .4, .415, .46, .63, .66, .86, .9, 1],
    opacity: [1, .12, .12, .65, .18, 1, 1, .08, .08, .5, 1, 1],
    opacityTimes: [0, .08, .4, .415, .435, .46, .63, .66, .86, .88, .9, 1],
    opacityEasing: "steps(1,end)",
  },
  {
    spokes: [1, 4, 7],
    shifts: [[0, 0], [-.8, .3], [.65, -.2], [-.8, .3], [0, 0], [0, 0], [.95, 0], [-.5, .2], [.95, 0], [0, 0], [0, 0], [-.75, -.3], [.4, .2], [-.75, -.3], [0, 0], [0, 0]],
    shiftTimes: [0, .15, .17, .185, .205, .29, .315, .33, .35, .365, .69, .735, .75, .77, .795, 1],
    opacity: [1, .08, 1, .15, .9, 1, 1, .1, .85, .05, 1, 1, .12, 1, .2, .75, 1, 1],
    opacityTimes: [0, .15, .17, .185, .205, .225, .29, .315, .33, .35, .365, .69, .735, .75, .77, .795, .82, 1],
    opacityEasing: "steps(1,end)",
  },
  {
    spokes: [2, 5],
    shifts: [[0, 0], [0, 0], [.35, .95], [.35, .95], [-.4, -.6], [0, 0], [0, 0], [.6, -.8], [0, 0], [0, 0]],
    shiftTimes: [0, .22, .245, .52, .54, .57, .8, .825, .89, 1],
    opacity: [1, 1, .4, .2, .55, .28, .75, 1, 1, .18, .7, 1],
    opacityTimes: [0, .18, .245, .32, .41, .49, .55, .61, .8, .825, .9, 1],
    opacityEasing: "linear",
  },
];

const motions: LoaderMotion[] = [
  // circular fold
  {
    weight: 10,
    duration: 2160,
    tracks: () => foldTracks(2160, i => {
      const start = foldStarts[i]!;
      return [start, start + 550, start + 1080, start + 1630];
    }),
  },
  // circular bounce
  {
    weight: 25,
    duration: 2100,
    tracks: (): Track[] => directions.map(([x, y], target) => {
      const start = bounceStarts[target]!;
      const rest = { transform: "translate(0px,0px)" };
      return { target, frames: [
        { ...rest, offset: 0 },
        { ...rest, offset: start / 2100, easing: "cubic-bezier(.2,.8,.3,1)" },
        { transform: `translate(${x! * -1.8}px,${y! * -1.8}px)`, offset: (start + 320) / 2100, easing: ease },
        { ...rest, offset: (start + 900) / 2100 },
        { ...rest, offset: 1 },
      ] };
    }),
  },
  // circular collection
  {
    weight: 10,
    duration: 4800,
    tracks: (): Track[] => [
      ...collectorTimes.map(([hide, show], target): Track => ({
        target,
        frames: target === 0
          ? [{ opacity: 0, offset: 0, easing: "steps(1,end)" }, { opacity: 1, offset: 1 }]
          : [
            { opacity: 1, offset: 0, easing: "steps(1,end)" },
            { opacity: 0, offset: hide, easing: "steps(1,end)" },
            { opacity: 1, offset: show },
            { opacity: 1, offset: 1 },
          ],
      })),
      { target: "traveller", easing: "cubic-bezier(.42,0,.58,1)", frames: [
        { opacity: 1, transform: "rotate(0deg)" },
        { opacity: 1, transform: "rotate(720deg)" },
      ] },
    ],
  },
  // even-odd circular fold
  {
    weight: 40,
    duration: 4020,
    tracks: () => foldTracks(4020, i => {
      const start = Math.floor(i / 2) * 140 + (i % 2 ? 1440 : 0);
      return [start, start + 720, start + 1440, start + 2160];
    }),
  },
  // wind up
  {
    weight: 15,
    duration: 2800,
    tracks: (): Track[] => directions.flatMap(([x, y], index): Track[] => [
      { target: { rotation: index }, frames: [
        { transform: "rotate(0deg)", offset: 0, easing: "cubic-bezier(.4,0,.6,1)" },
        { transform: "rotate(-30deg)", offset: .25, easing: "cubic-bezier(.15,.65,.25,1)" },
        { transform: "rotate(360deg)", offset: 1 },
      ] },
      { target: index, frames: [
        { transform: "translate(0px,0px)", offset: 0, easing: "cubic-bezier(.4,0,.6,1)" },
        { transform: `translate(${x}px,${y}px)`, offset: .25, easing: "cubic-bezier(.2,.8,.3,1)" },
        { transform: `translate(${x! * -1.8}px,${y! * -1.8}px)`, offset: .36, easing: "cubic-bezier(.4,0,.6,1)" },
        { transform: "translate(0px,0px)", offset: 1 },
      ] },
    ]),
  },
  // even-odd spin
  {
    weight: 15,
    duration: 2400,
    tracks: (): Track[] => directions.flatMap(([x, y], index): Track[] => [
      { target: { rotation: index }, easing: "cubic-bezier(.42,0,.58,1)", frames: [
        { transform: "rotate(0deg)" },
        { transform: `rotate(${index % 2 ? 360 : -360}deg)` },
      ] },
      { target: index, frames: [
        { transform: "translate(0px,0px)", offset: 0, easing: "cubic-bezier(.7,0,.3,1)" },
        { transform: `translate(${x! * -1.8}px,${y! * -1.8}px)`, offset: .5, easing: "cubic-bezier(.7,0,.3,1)" },
        { transform: "translate(0px,0px)", offset: 1 },
      ] },
    ]),
  },
  // even-odd push
  {
    weight: 20,
    duration: 2000,
    tracks: (): Track[] => directions.map((_, index): Track => ({
      target: { rotation: index },
      frames: index % 2 ? [
        { transform: "rotate(0deg)", offset: 0, easing: ease },
        { transform: "rotate(45deg)", offset: .4, easing: ease },
        { transform: "rotate(135deg)", offset: .8 },
        { transform: "rotate(135deg)", offset: 1 },
      ] : [
        { transform: "rotate(0deg)", offset: 0 },
        { transform: "rotate(0deg)", offset: .2, easing: ease },
        { transform: "rotate(90deg)", offset: .6, easing: ease },
        { transform: "rotate(135deg)", offset: 1 },
      ],
    })),
  },
  // even-odd opposing self-spin
  {
    weight: 5,
    duration: 2400,
    tracks: (): Track[] => directions.flatMap(([x, y], index): Track[] => {
      const travel = index % 2 ? -1.6 : 3.0;
      // Normalise the rounded diagonal directions for the approved radial distance.
      const length = Math.hypot(x!, y!);
      const displaced = `translate(${x! / length * travel}px,${y! / length * travel}px)`;
      return [
        { target: { rotation: index }, easing: "cubic-bezier(.42,0,.58,1)", frames: [
          { transform: "rotate(0deg)" },
          { transform: `rotate(${index % 2 ? 360 : -360}deg)` },
        ] },
        { target: index, frames: [
          { transform: "translate(0px,0px)", opacity: 1, offset: 0, easing: "cubic-bezier(.4,0,.6,1)" },
          { transform: displaced, opacity: index % 2 ? 1 : .65, offset: .32 },
          { transform: displaced, opacity: index % 2 ? 1 : .65, offset: .68, easing: "cubic-bezier(.4,0,.6,1)" },
          { transform: "translate(0px,0px)", opacity: 1, offset: 1 },
        ] },
        { target: { selfRotation: index }, easing: "cubic-bezier(.42,0,.58,1)", frames: [
          { transform: "rotate(0deg)" },
          { transform: `rotate(${index % 2 ? -1440 : 1440}deg)` },
        ] },
      ];
    }),
  },
  // glitch: overlapping faults, chatter and gradual braking
  {
    weight: 5,
    duration: 3200,
    tracks: (): Track[] => [
      { target: "brake", easing: "cubic-bezier(.25,0,.75,1)", frames: [
        { transform: "rotate(0deg)" }, { transform: "rotate(-90deg)" },
      ] },
      { target: "jitter", frames: [0, -9, -9, 3, 0, 0, -13, -5, 0, 0].map((angle, index) => ({
        transform: `rotate(${angle}deg)`,
        offset: [0, .09, .34, .35, .39, .58, .61, .72, .87, 1][index],
        easing: "steps(1,end)",
      })) },
      ...glitchCircuits.flatMap(circuit => circuit.spokes.flatMap((target): Track[] => [
        { target, frames: circuit.shifts.map(([x, y], index) => ({
          transform: `translate(${x}px,${y}px)`, offset: circuit.shiftTimes[index], easing: "steps(1,end)",
        })) },
        { target, frames: circuit.opacity.map((opacity, index) => ({
          opacity, offset: circuit.opacityTimes[index], easing: circuit.opacityEasing,
        })) },
      ])),
    ],
  },
];

export default class LoaderAnimationController {
  private state: "idle" | "running" | "disposed" | "failed" = "idle";
  private animations: Array<ReturnType<LoaderAnimator>> = [];
  private previous: number[] = [];

  constructor(private readonly animate: LoaderAnimator, private readonly random = Math.random, private readonly warn = () => console.warn("Loader animation failed."), private readonly catalog: readonly LoaderMotion[] = motions) {}

  start() {
    if (this.state !== "idle") return;
    this.state = "running";
    try {
      this.own("spin", [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 8000, iterations: Infinity });
      this.next();
    } catch {
      this.fail();
    }
  }

  dispose() {
    this.state = "disposed";
    this.clear();
  }

  private own(target: Parameters<LoaderAnimator>[0], frames: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = this.animate(target, frames, options);
    this.animations.push(animation);
    // Cancellation is expected only after the owner has left running state.
    void animation.finished.catch(() => this.fail());
    return animation;
  }

  private next() {
    if (this.state !== "running") return;
    const choices = this.catalog.map((_, index) => index).filter(index => !this.previous.includes(index));
    let ticket = this.random() * choices.reduce((total, index) => total + this.catalog[index]!.weight, 0);
    const index = choices.find(index => {
      ticket -= this.catalog[index]!.weight;
      return ticket < 0;
    })!;
    this.previous.push(index);
    if (this.previous.length > 4) this.previous.shift();
    const motion = this.catalog[index]!;
    const batch = motion.tracks().map(track => this.own(track.target, track.frames, {
      duration: motion.duration, fill: "both", easing: track.easing ?? "linear",
    }));
    void Promise.all(batch.map(animation => animation.finished)).then(() => {
      if (this.state !== "running") return;
      // Retain the independent outer spin while removing the completed inner effects.
      this.animations.splice(1).forEach(animation => animation.cancel());
      this.next();
    }).catch(() => this.fail());
  }

  private fail() {
    if (this.state !== "running") return;
    this.state = "failed";
    this.clear();
    this.warn();
  }

  private clear() {
    this.animations.splice(0).forEach(animation => animation.cancel());
  }
}
