// THE LADDER - the "How the World Works" curriculum, precalculus to quantum.
//
// Ben wrote the syllabus; this is it as data. Two rules held while building it:
//
// 1. EVERY VIDEO ID BELOW WAS VERIFIED. Each one was checked against YouTube's
//    oEmbed endpoint at authoring time - it exists, it is public, it is
//    embeddable - and the `title` and `channel` strings are the ones YouTube
//    returned, not ones typed from memory. Seventeen candidates failed that
//    check and were dropped rather than shipped as dead links.
// 2. THE PREREQUISITE ORDER IS THE POINT. Chapters are ordered so the maths
//    always leads the physics. The app gates nothing - Ben can open any chapter -
//    but `gate` says plainly what a chapter assumes, because the honest answer
//    to "can I do Schrodinger yet" is usually no.
//
// The clip generator this replaces never produced a single finished video.

export type ChapterVideo = { id: string; title: string; channel: string; why: string };
export type LadderChapter = {
  idx: number; title: string; objective: string; summary: string;
  videos: ChapterVideo[];
};

export const LADDER_NOTEBOOK = "How the World Works";

export const LADDER: LadderChapter[] = [
  {
    idx: 0,
    title: "Functions, Graphs & Algebra Fluency",
    objective: "Read any function as a rule that maps inputs to outputs, and move fluently between exponentials and logs.",
    summary: "The grammar every later equation is written in. A function is a deterministic rule; graphing and transformations are how you see one; exponentials and logs are inverse views of the same relationship.",
    videos: [
      { id: "9OOrhA2iKak", title: "Intro to Precalculus (Precalculus - College Algebra 1)", channel: "Professor Leonard", why: "Where the course starts and what it is actually for." },
      { id: "FkUEsP9efFg", title: "Introduction to Functions (Precalculus - College Algebra 2)", channel: "Professor Leonard", why: "What a function is, defined properly - the definition everything later leans on." },
      { id: "EsgHKmLSPVc", title: "Composition of Functions (Precalculus - College Algebra 48)", channel: "Professor Leonard", why: "Composing functions, which is the same move as chaining transformations later." },
      { id: "2w14jBb0e9Q", title: "Graphs of Exponential Functions (Precalculus - College Algebra 52)", channel: "Professor Leonard", why: "Exponential graphs, the shape behind growth, decay and half-lives." },
      { id: "sULa9Lc4pck", title: "Triangle of Power", channel: "3Blue1Brown", why: "Exponents, roots and logs as three views of one relationship - fixes the notation confusion before it costs you." },
    ],
  },
  {
    idx: 1,
    title: "Trigonometry & the Unit Circle",
    objective: "Derive sine and cosine from the unit circle and explain why they describe everything that oscillates.",
    summary: "Sine and cosine are just the coordinates of a point going round a circle. That is literally the mathematics of every wave, every AC current, and every quantum phase you will meet later.",
    videos: [
      { id: "57VrEiEPD1I", title: "The Unit Circle, Basic Introduction, Trigonometry", channel: "The Organic Chemistry Tutor", why: "The core idea, slowly: where sin and cos actually come from." },
      { id: "gdJq1QunN-o", title: "How To Remember The Unit Circle Fast!", channel: "The Organic Chemistry Tutor", why: "The memorisation trick, so the circle stops being a lookup table." },
      { id: "7_qJQsmXYX8", title: "Trigonometry Course, Basic Introduction, Unit Circle, Sin Cos Tan, Right Triangles", channel: "The Organic Chemistry Tutor", why: "Long-form course if you want the drilling in one place." },
      { id: "r6sGWTCMz2k", title: "But what is a Fourier series?  From heat flow to drawing with circles   DE4", channel: "3Blue1Brown", why: "Why any repeating signal is a stack of sines - the payoff, previewed." },
    ],
  },
  {
    idx: 2,
    title: "Differential Calculus: Limits & Derivatives",
    objective: "Compute a derivative from the limit definition and explain what it measures.",
    summary: "A derivative is an instantaneous rate of change - the limit of a slope as the interval shrinks to nothing. It turns position into velocity. This is the first real wall; do problems, not just videos.",
    videos: [
      { id: "WUvTyaaNkzM", title: "The essence of calculus", channel: "3Blue1Brown", why: "Start here. The whole subject in one sitting, built from area and slope." },
      { id: "9vKqVkMQHKk", title: "The paradox of the derivative   Chapter 2, Essence of calculus", channel: "3Blue1Brown", why: "The honest paradox: what does change 'at an instant' even mean?" },
      { id: "S0_qX4VJhMQ", title: "Derivative formulas through geometry   Chapter 3, Essence of calculus", channel: "3Blue1Brown", why: "Where the rules come from geometrically, so they stop being memorised." },
      { id: "3d6DsjIBzJ4", title: "Taylor series   Chapter 11, Essence of calculus", channel: "3Blue1Brown", why: "Taylor series - why any smooth function is secretly a polynomial." },
    ],
  },
  {
    idx: 3,
    title: "Integral Calculus & the Fundamental Theorem",
    objective: "Compute an area two ways - as a limit of sums and via an antiderivative - and show they agree.",
    summary: "An integral accumulates a quantity: area, distance, charge. The Fundamental Theorem then shows integration and differentiation are inverse operations. That is the deepest idea in first-year mathematics.",
    videos: [
      { id: "rfG8ce4nNh0", title: "Integration and the fundamental theorem of calculus   Chapter 8, Essence of calculus", channel: "3Blue1Brown", why: "Integration and the Fundamental Theorem, motivated rather than asserted." },
      { id: "FnJqaIESC2s", title: "What does area have to do with slope?   Chapter 9, Essence of calculus", channel: "3Blue1Brown", why: "Why area and slope are the same question asked backwards." },
      { id: "CfW845LNObM", title: "The other way to visualize derivatives   Chapter 12, Essence of calculus", channel: "3Blue1Brown", why: "A second visual model of the derivative that makes integrals click." },
    ],
  },
  {
    idx: 4,
    title: "Multivariable & Vector Calculus",
    objective: "Compute divergence and curl of a field and say in one sentence what each number physically means.",
    summary: "Calculus in three dimensions: partial derivatives, gradients, divergence, curl, line and surface integrals. This is the exact machinery of physical fields, and it is what Maxwell's equations are written in.",
    videos: [
      { id: "rB83DpBJQsE", title: "Divergence and curl:  The language of Maxwell's equations, fluid flow, and more", channel: "3Blue1Brown", why: "Divergence and curl with the geometry made visible - the single most useful video before E&M." },
      { id: "tIpKfDc295M", title: "Gradient", channel: "Khan Academy", why: "The gradient as the direction of steepest ascent." },
    ],
  },
  {
    idx: 5,
    title: "Linear Algebra",
    objective: "Find eigenvalues and eigenvectors of a 2x2 matrix by hand and draw what the matrix does to the unit square.",
    summary: "Vectors, matrices as transformations, basis, eigenvectors. Independent of calculus, so it can run in parallel. This is the native language of quantum states and operators - do not skip it.",
    videos: [
      { id: "fNk_zzaMoSs", title: "Vectors   Chapter 1, Essence of linear algebra", channel: "3Blue1Brown", why: "What a vector actually is, before any matrix appears." },
      { id: "kYB8IZa5AuE", title: "Linear transformations and matrices   Chapter 3, Essence of linear algebra", channel: "3Blue1Brown", why: "The central idea: a matrix IS a linear transformation." },
      { id: "XkY2DOUCWMU", title: "Matrix multiplication as composition   Chapter 4, Essence of linear algebra", channel: "3Blue1Brown", why: "Matrix multiplication as composing two transformations." },
      { id: "rHLEWRxRGiM", title: "Three-dimensional linear transformations   Chapter 5, Essence of linear algebra", channel: "3Blue1Brown", why: "The same picture in three dimensions." },
      { id: "uQhTuRlWMxw", title: "Inverse matrices, column space and null space   Chapter 7, Essence of linear algebra", channel: "3Blue1Brown", why: "Inverses, column space and null space - what solving a system means geometrically." },
      { id: "v8VSDg_WQlA", title: "Nonsquare matrices as transformations between dimensions   Chapter 8, Essence of linear algebra", channel: "3Blue1Brown", why: "Non-square matrices as maps between dimensions." },
      { id: "PFDu9oVAE-g", title: "Eigenvectors and eigenvalues   Chapter 14, Essence of linear algebra", channel: "3Blue1Brown", why: "Eigenvectors: the directions a transformation does not rotate. This is the one quantum needs." },
    ],
  },
  {
    idx: 6,
    title: "Differential Equations & Fourier",
    objective: "Solve the simple harmonic oscillator by hand and show sine and cosine satisfy it.",
    summary: "An equation relating a function to its own rate of change. Solving one predicts how a system evolves: a pendulum, a decaying charge, a vibrating string. Fourier decomposes any signal into sines.",
    videos: [
      { id: "p_di4Zn4wz4", title: "Differential equations, a tourist's guide   DE1", channel: "3Blue1Brown", why: "The tour: what differential equations are and why they are everywhere." },
      { id: "ly4S0oi3Yz8", title: "But what is a partial differential equation?    DE2", channel: "3Blue1Brown", why: "Partial differential equations, where fields and waves live." },
      { id: "ToIXSwZ1pJU", title: "Solving the heat equation   DE3", channel: "3Blue1Brown", why: "The heat equation solved end to end - the template for Schrodinger later." },
      { id: "r6sGWTCMz2k", title: "But what is a Fourier series?  From heat flow to drawing with circles   DE4", channel: "3Blue1Brown", why: "Fourier series, properly this time." },
      { id: "spUNpyF58BY", title: "But what is the Fourier Transform?  A visual introduction.", channel: "3Blue1Brown", why: "The Fourier transform - the machinery behind the uncertainty principle." },
    ],
  },
  {
    idx: 7,
    title: "Newtonian Mechanics",
    objective: "Derive projectile range from F=ma and show it is maximised at 45 degrees.",
    summary: "Three laws plus calculus predicts the motion of anything from a thrown ball to a planet. Momentum and energy conservation do most of the work. Needs differential and integral calculus first.",
    videos: [
      { id: "ZM8ECpBuQYE", title: "Motion in a Straight Line: Crash Course Physics #1", channel: "CrashCourse", why: "Motion, velocity and acceleration set up cleanly." },
      { id: "kKKM8Y-u7ds", title: "Newton's Laws: Crash Course Physics #5", channel: "CrashCourse", why: "The three laws, and what each one actually claims." },
      { id: "E43-CfukEgs", title: "Brian Cox visits the world's biggest vacuum   Human Universe - BBC", channel: "BBC", why: "A feather and a bowling ball in a real vacuum chamber. Worth it for the moment the intuition breaks." },
    ],
  },
  {
    idx: 8,
    title: "Lagrangian Mechanics & Least Action",
    objective: "Write L = T - V for a mass in gravity, put it through Euler-Lagrange, and recover a = -g.",
    summary: "Instead of tracking forces, define the Lagrangian as kinetic minus potential energy; nature takes the path that makes the action stationary. Reproduces Newton and generalises to all of physics. Deferrable - beautiful, but not load-bearing for the route to quantum.",
    videos: [
      { id: "sUk9y23FPHk", title: "Explaining the Principle of Least Action: Physics Mini Lesson", channel: "Physics with Elliot", why: "The principle of least action in one clean lesson." },
      { id: "Q10_srZ-pbs", title: "The Closest We’ve Come to a Theory of Everything", channel: "Veritasium", why: "Why this reformulation, not Newton's, is the one that survives into modern physics." },
    ],
  },
  {
    idx: 9,
    title: "Oscillations & Waves",
    objective: "Draw the first three standing-wave modes of a fixed string and compute their wavelengths in terms of L.",
    summary: "Anything pushed back toward equilibrium in proportion to its displacement oscillates sinusoidally. Couple those oscillators and you get travelling waves, standing waves, resonance and interference - the substrate of sound, light, and the quantum wavefunction.",
    videos: [
      { id: "CR_XL192wXw", title: "Chladni Figures - random couscous snaps into beautiful patterns", channel: "Steve Mould", why: "Standing waves made visible in two dimensions - the clearest demonstration of modes there is." },
      { id: "wYoxOJDrZzw", title: "Singing plates - Standing Waves on Chladni plates", channel: "Physics Girl", why: "The same effect on singing plates, with the physics spelled out." },
      { id: "EQT9v_aEhW0", title: "Metal plate resonance experiments (Chladni plate)", channel: "MatthiasWandel", why: "Resonance found experimentally rather than derived - useful for intuition about mode shapes." },
    ],
  },
  {
    idx: 10,
    title: "Thermodynamics & Statistical Mechanics",
    objective: "Draw a Carnot cycle on a P-V diagram and compute its efficiency between two temperatures.",
    summary: "Temperature, heat and entropy emerge from the statistics of enormous numbers of particles. The four laws govern engines, refrigerators and the arrow of time. Can be studied out of order - it is not a hard prerequisite for the route to quantum, but it is essential for engines.",
    videos: [
      { id: "DWiCaDPM7Hk", title: "Second Law of Thermodynamics - Heat Energy, Entropy & Spontaneous Processes", channel: "The Organic Chemistry Tutor", why: "The second law and entropy worked through with real numbers." },
      { id: "hIBPIOQdB_U", title: "Entropy and the Second Law of Thermodynamics Explained   Spontaneity, Heat Flow and Microstates", channel: "Quizlet", why: "Entropy as a count of microstates - the statistical picture, which is the honest one." },
      { id: "6bo12veBMds", title: "Brayton Cycle How a Jet Engine Works", channel: "VAM! Physics & Engineering", why: "A thermodynamic cycle traced through a real machine, which is where the abstractions land." },
    ],
  },
  {
    idx: 11,
    title: "Electromagnetism to Maxwell's Equations",
    objective: "Write all four Maxwell equations in integral form and state the physical claim each one makes.",
    summary: "Charges make electric fields, moving charges make magnetic fields, and changing fields make each other. Four equations unify all of it and predict light. This is the second wall, and the first place vector calculus becomes non-optional.",
    videos: [
      { id: "bHIhgxav9LY", title: "The Biggest Misconception About Electricity", channel: "Veritasium", why: "The one that overturns what you were taught: energy travels in the field, not down the wire." },
      { id: "oI_X2cMHNe0", title: "How Electricity Actually Works", channel: "Veritasium", why: "The follow-up, with the measurements that settle it." },
      { id: "hFAOXdXZ5TM", title: "MAGNETS: How Do They Work?", channel: "minutephysics", why: "Magnetism from first principles, which is stranger than it looks." },
      { id: "rB83DpBJQsE", title: "Divergence and curl:  The language of Maxwell's equations, fluid flow, and more", channel: "3Blue1Brown", why: "Re-watch once vector calculus is in: this IS Maxwell's language." },
    ],
  },
  {
    idx: 12,
    title: "Special Relativity",
    objective: "Draw a spacetime diagram for the twin paradox and compute the age difference for a chosen speed.",
    summary: "One postulate - light has the same speed for everyone - forces time dilation, length contraction, and E=mc2. Mathematically light, conceptually deep. Can be taken any time after mechanics.",
    videos: [
      { id: "1rLWVZVWfdY", title: "Why is Relativity Hard?   Special Relativity Chapter 1", channel: "minutephysics", why: "Chapter 1 of the best free relativity series: why the subject feels hard." },
      { id: "ACUuFg9Y9dY", title: "Would Headlights Work at Light Speed?", channel: "Vsauce", why: "The thought experiment that makes the constancy of c feel wrong, then right." },
    ],
  },
  {
    idx: 13,
    title: "Quantum Mechanics I: The Wavefunction",
    objective: "Solve the 1D particle in a box, derive the allowed energies, and sketch the first three wavefunctions.",
    summary: "A particle's state is a complex wavefunction; its squared magnitude is a probability density; the Schrodinger equation says how it evolves. Confining a wave to a region forces discrete wavelengths - that is where quantisation comes from, mechanically. Needs linear algebra, differential equations and waves first.",
    videos: [
      { id: "tXR1D_N8tm8", title: "What *is* the wavefunction?", channel: "Looking Glass Universe", why: "What the wavefunction is, without the mysticism." },
      { id: "p7bzE1E5PMY", title: "Visualization of Quantum Physics (Quantum Mechanics)", channel: "udiprod", why: "Watch wavefunctions actually evolve and scatter." },
      { id: "MzRCDLre1b4", title: "Some light quantum mechanics (with minutephysics)", channel: "3Blue1Brown", why: "Quantum ideas built on the wave intuition you already have." },
      { id: "lZ3bPUKo5zc", title: "Lecture 1: Introduction to Superposition", channel: "MIT OpenCourseWare", why: "MIT 8.04 lecture one, for when you want the real course rather than the tour." },
    ],
  },
  {
    idx: 14,
    title: "Quantum Mechanics II: Uncertainty & Interpretations",
    objective: "Explain why localising a wave in space necessarily spreads it in wavelength - and say which parts of quantum are settled and which are not.",
    summary: "Uncertainty is not clumsy measurement. It is the Fourier trade-off built into wave geometry. SETTLED: the mathematics, the Born rule, quantisation, uncertainty - all experimentally airtight. CONTESTED: whether the wavefunction collapses, branches, or is guided. No experiment to date separates those. Treat any source presenting one as the truth with suspicion.",
    videos: [
      { id: "a8FTr2qMutA", title: "Heisenberg's Uncertainty Principle Explained", channel: "Veritasium", why: "Uncertainty as a real physical constraint, with the experiment." },
      { id: "MBnnXbOM5S4", title: "The more general uncertainty principle, regarding Fourier transforms", channel: "3Blue1Brown", why: "The deep version: uncertainty is a theorem about Fourier transforms, not about physics being shy." },
    ],
  },
  {
    idx: 15,
    title: "Solid-State Physics & Band Theory",
    objective: "Draw band diagrams for a conductor, insulator and semiconductor, and explain why a small gap is crossable at room temperature.",
    summary: "Pack atoms into a crystal and their discrete energy levels smear into bands separated by gaps. Whether the top band is full, and how wide the gap is, decides conductor versus insulator versus semiconductor. The intuition is watchable now; the why lands after quantum.",
    videos: [
      { id: "zdmEaXnB-5Q", title: "Band theory (semiconductors) explained", channel: "PhysicsHigh", why: "Band theory stated plainly, with the three cases side by side." },
      { id: "hrpPKCDLRN0", title: "Semiconductors - Physics inside Transistors and Diodes", channel: "Physics Videos by Eugene Khutoryansky", why: "The same physics animated inside real devices." },
      { id: "33vbFFFn04k", title: "How semiconductors work", channel: "Ben Eater", why: "Built from the electron up, by someone who then builds a computer out of it." },
    ],
  },
  {
    idx: 16,
    title: "Doping, the PN Junction & the Diode",
    objective: "Draw a PN junction at equilibrium and under both biases, and explain why current flows only one way.",
    summary: "Trace impurities give a semiconductor spare electrons or spare holes. Join the two types and carriers diffuse across, leaving a depletion region and a built-in field: a one-way valve for current.",
    videos: [
      { id: "lBy_Mj1d0AA", title: "Doping and Band Diagrams", channel: "Jordan Edmunds Chetty", why: "Doping drawn on the band diagram, which is the only way it makes sense." },
      { id: "JBtEckh3L9Q", title: "The PN Junction. How Diodes Work? (English version)", channel: "fmgomezcampos", why: "The junction itself, step by step." },
      { id: "Fwj_d3uO5g8", title: "Diodes Explained - The basics how diodes work working principle pn junction", channel: "The Engineering Mindset", why: "The practical device and how it behaves in a circuit." },
    ],
  },
  {
    idx: 17,
    title: "Transistors & MOSFETs",
    objective: "Draw a MOSFET cross-section and narrate what happens as gate voltage rises from zero.",
    summary: "A gate voltage creates or destroys a conducting channel between source and drain - an electrically controlled switch with no moving parts. Billions of them flipping between 0 and 1 is the physical substrate of all computing.",
    videos: [
      { id: "_Pqfjer8-O4", title: "How do Transistors Build into a CPU?  🖥️🤔  How do Transistors Work? 🖥️🤔", channel: "Branch Education", why: "From a single transistor up to the structures a CPU is made of." },
      { id: "AwRJsze_9m4", title: "MOSFET Explained - How MOSFET Works", channel: "The Engineering Mindset", why: "The device explained as an engineer uses it." },
      { id: "Bfvyj88Hs_o", title: "How a MOSFET Works - with animation!    Intermediate Electronics", channel: "CircuitBread", why: "Animated carrier motion inside the channel." },
    ],
  },
  {
    idx: 18,
    title: "From Transistors to CPUs and GPUs",
    objective: "Build a half-adder from logic gates and write out its truth table.",
    summary: "Transistors combine into gates, gates into adders and registers and memory, and those into a processor that fetches, decodes and executes. This is the rung where the physics becomes computing.",
    videos: [
      { id: "16zrEPOsIcI", title: "The Engineering that Runs the Digital World 🛠️⚙️💻 How do CPUs Work?", channel: "Branch Education", why: "The whole path from gate to executing instruction, in 3D." },
      { id: "h9Z4oGN89MU", title: "How do Graphics Cards Work?  Exploring GPU Architecture", channel: "Branch Education", why: "Why a GPU is a different shape of machine than a CPU." },
      { id: "7J7X7aZvMXQ", title: "How does Computer Memory Work? 💻🛠", channel: "Branch Education", why: "How memory physically remembers a bit." },
      { id: "HyznrdDSSGM", title: "8-bit computer update", channel: "Ben Eater", why: "Ben Eater builds one on a breadboard - the antidote to hand-waving." },
    ],
  },
  {
    idx: 19,
    title: "Chip Fabrication",
    objective: "Draw the photolithography loop and annotate which physical principle each step relies on.",
    summary: "Chips are built up layer by layer by photolithography: coat, project a mask, etch, dope, repeat dozens of times. The leading edge uses 13.5nm extreme-ultraviolet light made by vaporising tin droplets into plasma with a high-power laser.",
    videos: [
      { id: "dX9CGRZwD-w", title: "How are Microchips Made? 🖥️🛠️ CPU Manufacturing Process Steps", channel: "Branch Education", why: "The full manufacturing sequence, start to finish." },
      { id: "B2482h_TNwg", title: "The $200M Machine that Prints Microchips:  The EUV Photolithography System", channel: "Branch Education", why: "The EUV machine itself - arguably the most complex device humans build." },
      { id: "IkRXpFIRUl4", title: "How are microchips made? - George Zaidan and Sajan Saini", channel: "TED-Ed", why: "A short, tight version if you want the shape before the detail." },
      { id: "iSVHp6CAyQ8", title: "Why The World Relies On ASML For Machines That Print Chips", channel: "CNBC", why: "Why exactly one company on earth makes these machines." },
    ],
  },
  {
    idx: 20,
    title: "Electricity Generation & the Power Grid",
    objective: "Trace energy from a spinning turbine to a lightbulb, labelling every conversion and transformer.",
    summary: "Faraday's law turned rotation into electricity: spin a magnet inside coils and you induce AC. Transformers step voltage up for low-loss transmission and back down for use, and the grid has to balance generation against load in real time because electricity barely stores.",
    videos: [
      { id: "v1BMWczn7JM", title: "How Does the Power Grid Work?", channel: "Practical Engineering", why: "The grid as a system, explained by a civil engineer who builds them." },
      { id: "AHFZVn38dTM", title: "How Electricity Generation Really Works", channel: "Practical Engineering", why: "What is actually happening inside the generator." },
      { id: "ZwkNTwWJP5k", title: "The Most Confusing Part of the Power Grid", channel: "Practical Engineering", why: "Reactive power - the part almost everyone gets wrong." },
    ],
  },
  {
    idx: 21,
    title: "Engines & Flight",
    objective: "Draw the four strokes of an Otto cycle and the stages of a jet, and say how each obeys conservation of energy and momentum.",
    summary: "Heat engines convert chemical energy to work through a thermodynamic cycle. A jet's thrust is Newton's third law - throw air backwards. A wing works by turning airflow downward, which is the same law again.",
    videos: [
      { id: "aFO4PBolwFg", title: "How Does A Wing Actually Work?", channel: "Veritasium", why: "Lift explained honestly, including why the usual school explanation is wrong." },
      { id: "6bo12veBMds", title: "Brayton Cycle How a Jet Engine Works", channel: "VAM! Physics & Engineering", why: "The Brayton cycle mapped onto a real engine." },
      { id: "4bKXcbV8nwg", title: "How a Jet Engine Works", channel: "Aero Monitor", why: "The mechanical walk-through of a jet engine." },
      { id: "zaOkU27MwSM", title: "How Does a Jet Engine Work? The Complete Engineering Explanation   Mech Cosmos", channel: "Mech Cosmos", why: "A longer engineering treatment if the first two leave you wanting more." },
    ],
  },
  {
    idx: 22,
    title: "Radio & Wireless",
    objective: "Sketch a carrier wave and show how amplitude and frequency modulation each encode the same signal.",
    summary: "Maxwell's equations predict that an oscillating current radiates. Modulate the wave and you have encoded information; an antenna run in reverse recovers it. Everything wireless is this one idea plus engineering.",
    videos: [
      { id: "ZaXm6wau-jc", title: "How does an Antenna work?   ICT #4", channel: "Sabin Civil Engineering", why: "What an antenna is actually doing to make a field detach and travel." },
      { id: "1I1vxu5qIUM", title: "How does Bluetooth Work?", channel: "Branch Education", why: "A complete real protocol, from radio physics up to pairing." },
      { id: "hFAOXdXZ5TM", title: "MAGNETS: How Do They Work?", channel: "minutephysics", why: "Back to the field itself, since that is what is radiating." },
    ],
  },
  {
    idx: 23,
    title: "Lasers",
    objective: "Draw a three-level laser diagram and explain why a two-level system cannot sustain lasing.",
    summary: "Pump atoms into an excited state until more are excited than not - a population inversion. One photon then triggers stimulated emission of an identical photon, and a mirror cavity amplifies that into a coherent beam. Depends on quantum energy levels.",
    videos: [
      { id: "xZ9kSBHWpUM", title: "Stimulated Emission Explained", channel: "Jordan Edmunds Chetty", why: "Stimulated emission on its own, which is the one idea the rest hangs off." },
      { id: "Ka7kuISlNSE", title: "How is a photon in a LASER created? Stimulated Emissions", channel: "See the Pattern", why: "Where the photon actually comes from, at the level of the atom." },
      { id: "TnOYRyG4GUc", title: "LASER - Light Amplification by Stimulated Emission of Radiation", channel: "BIOPHYMAN", why: "Population inversion and the cavity assembled into a working laser." },
      { id: "_JOchLyNO_w", title: "How Lasers Work - A Complete Guide", channel: "Scientized", why: "A full walk-through if you want the engineering as well as the physics." },
    ],
  },
  {
    idx: 24,
    title: "Batteries & Energy Storage",
    objective: "Draw a lithium-ion cell discharging, label electron and ion paths, and write the half-reactions.",
    summary: "A battery converts chemical energy to electrical energy by redox: ions move internally through the electrolyte while electrons are forced through the external circuit. In a lithium-ion cell the same ions shuttle back and forth between graphite and a metal oxide.",
    videos: [
      { id: "4-1psMHSpKs", title: "How a Lithium Ion Battery Actually Works // Photorealistic // 16 Month Project", channel: "The Limiting Factor", why: "The best battery explainer on the platform - photorealistic, down to the particle." },
      { id: "VxMM4g2Sk8U", title: "Lithium-ion battery, How does it work?", channel: "Sabin Civil Engineering", why: "A shorter version covering the same charge/discharge cycle." },
    ],
  },
];

// Roughly how far up the ladder the maths carries you. Used to show an honest
// "this needs X first" line rather than pretending everything is available now.
export const PHASE_OF = (idx: number): string =>
  idx <= 1 ? "precalculus"
  : idx <= 3 ? "single-variable calculus"
  : idx <= 6 ? "multivariable, linear algebra, differential equations"
  : idx <= 12 ? "calculus-based physics"
  : idx <= 14 ? "linear algebra + differential equations"
  : "quantum mechanics";
