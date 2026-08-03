# Learn AI — the idea

## What it is

An **engine for learning anything**, not a fixed-flow learning app.

The analogy is a **game engine for developers**. A game engine doesn't ship a game — it ships
rendering, physics, input, state, and the developer composes those primitives into whatever they
want. This ships the primitives of studying, and the learner composes them into whatever shape suits
them: a structured course, a bank of questions, free-form reading, a set of exercises, a study plan.
However the user wants their own course or study plan to be, they can generate it.

It is general-purpose by design. Any subject, any form.

## Where it came from

I was preparing for a C++ interview and needed to go deep on a lot of material. I didn't want a
course, a book, or YouTube videos — too much time spent wading through general content to extract the
few things I actually needed, none of it pitched at my level, none of it personalized.

So I opened Claude Code in a terminal and said: here's what I want, here's where I stand. Research all
the C++ skills and information I need, and build me a specific course. It produced a personalized
course I could open in the browser — a database of a few hundred questions I worked through one by
one, which remembered what I knew and what I didn't.

**That C++ course was one example of the output. It is not the product.** The product is the engine
that can produce it — and produce something completely different for someone learning German grammar,
options pricing, organic chemistry, or the Reformation.

## The core loop

Everything reduces to two alternating modes.

**1. Information in.** The learner reads, watches, understands. The system generates material fitted
to them — text, explanations, graphs, diagrams, whatever the subject calls for.

**2. The learner does something.** They write it down, work a math problem, produce an answer, draw a
diagram. Then the system looks at what they actually produced and evaluates it — step by step, not
just the final answer.

If they can't do it, that isn't a score event. It routes to more material and closer instruction:
*let me study this with you, here's more, here's why this happens* — until they can do the exercise
and understand why it works.

## How planning works

Not a complete course generated up front and then executed. Instead:

- A **broad roadmap** with visible phases, so the learner can see the shape of where they're going.
- **Each session generated on the spot**, against where the learner actually is by the time they get
  there.
- **Amorphous** — it flows with the student. The plan bends to how they're actually progressing, what
  they want to skip, and what they want to go deeper on.

"Today we're at this level, you want to learn this, so here's material to read and here are exercises
to do."

## Memory

The system keeps persistent structured knowledge of two things:

- **The subject** — a body of material and structure about what's being learned.
- **The learner** — what they know, per concept and per question, and how that's changing over time.

This is the part a chat window structurally cannot do. It's not enough to be smart in the moment; it
has to remember on day 34 what you got wrong in week 2.

## "I don't know" is a first-class answer

Not a wrong answer. Not a penalty. A distinct, high-information input that says *teach me this* — and
the system responds with deeper material on exactly that point, and adjusts what comes next.

## Progress

Lightly gamified. Scores. Daily tracking of how much was answered versus how much wasn't. And above
all, a visible **rate of improvement** over time — am I actually getting better, and how fast.

## The MVP

1. Open the app. A chat or voice interface asks, broadly, what you want to study.
2. You say it loosely — "I want to study math, and specifically this thing."
3. **No questionnaire.** Don't interrogate the learner about what they know. Give them a few
   exercises and infer their level from how they do.
4. Reason about it — all LLM, not scripted logic — and produce a study plan.
5. Show the plan to the learner.
6. "Today we're doing this." Generate this session's material.
7. Work it on a **whiteboard**: one long top-to-bottom surface that mixes generated reading material
   with exercises inline. Type, write, or draw your answers directly on it.
8. The model watches what you're producing and evaluates each step — correct, correct with a nudge,
   or back to more material.

Reading and doing are interleaved on the same surface, not separate screens.

## The device

A **native iPad app with Apple Pencil.** Handwriting is the intended input for working problems —
it's the natural medium for mathematics, and it's why the whiteboard is the central surface rather
than a text box.

## The architectural bet

The reasoning should be **LLM-heavy, not script-heavy**. Understanding the learner's intent, judging
where they stand, deciding what to teach next, choosing the material, writing the exercises, and
grading the work — all of it reasoned, not hard-coded.

The bet is that current models are good enough for this, especially in a domain like mathematics, and
that hard-coding the pedagogy would be the wrong move. Falling model prices make the experiment
affordable.

## What I'm testing first

Not retention. Not monetization. **Capability.**

Can a model hold a coherent, evolving plan across weeks? Generate material actually worth reading?
Produce exercises worth doing? And correctly evaluate handwritten work — including spotting *which
step* went wrong, not just whether the final answer is right?

Everything else is downstream of that answer.

## What I haven't decided

- What form generated material should take. Rich HTML with text and graphs? Something simpler? Is
  substantial reading material even needed, or is the exercise itself the material?
- Read-then-exercise, or exercises interleaved while reading? *(Current instinct: interleaved.)*
- How much of this can stay pure LLM reasoning before it needs real structure underneath it.

## Positioning

**A tool for you to personalize your own education.** Not an AI tutor. You use it to build your own
learning pipeline.
