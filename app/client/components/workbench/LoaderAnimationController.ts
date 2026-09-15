/*
 * Exports:
 * - LoaderAnimator: browser animation boundary for loader targets.
 * - default LoaderAnimationController: owns loader motion sequencing and disposal.
 */
export type LoaderAnimator = (target: "spin" | "traveller" | number | { rotation: number }, frames: Keyframe[], options: KeyframeAnimationOptions) => Pick<Animation, "finished" | "cancel">;

type Track = { target: Exclude<Parameters<LoaderAnimator>[0], "spin">; frames: Keyframe[]; easing?: string };
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

const motions = [
  {
    weight: 10,
    duration: 2160,
    tracks: () => foldTracks(2160, i => {
      const start = foldStarts[i]!;
      return [start, start + 550, start + 1080, start + 1630];
    }),
  },
  {
    weight: 20,
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
  {
    weight: 30,
    duration: 4020,
    tracks: () => foldTracks(4020, i => {
      const start = Math.floor(i / 2) * 140 + (i % 2 ? 1440 : 0);
      return [start, start + 720, start + 1440, start + 2160];
    }),
  },
  {
    weight: 20,
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
  {
    weight: 20,
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
];

export default class LoaderAnimationController {
  private state: "idle" | "running" | "disposed" | "failed" = "idle";
  private animations: Array<ReturnType<LoaderAnimator>> = [];
  private previous: number | null = null;

  constructor(private readonly animate: LoaderAnimator, private readonly random = Math.random, private readonly warn = () => console.warn("Loader animation failed.")) {}

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
    const choices = motions.map((_, index) => index).filter(index => index !== this.previous);
    let ticket = this.random() * choices.reduce((total, index) => total + motions[index]!.weight, 0);
    const index = choices.find(index => {
      ticket -= motions[index]!.weight;
      return ticket < 0;
    })!;
    this.previous = index;
    const motion = motions[index]!;
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
