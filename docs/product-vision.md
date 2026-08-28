# Product vision

This document is the current source of truth for what the product is, why it
exists, and how it should be described. Product copy, experience decisions, and
new strategic documents should start here.

The product is currently called **Learn AI**, and the repository and app still
use **Math Tutor** in several technical names. The founder expects the product
name to change. Neither name should be treated as part of the long-term vision.

This direction supersedes the positioning in
[`learn-ai-the-idea.md`](learn-ai-the-idea.md). That file is preserved as a
historical source because it records how the project began; it is not current
product guidance.

## The product

The product is a shared space for learning, understanding, and working through
problems. Its central surface is a whiteboard that the learner and an
intelligent tutor share.

The learner can write, calculate, sketch, select part of their work, and talk
through what they are trying to understand. The tutor can see the same board,
respond to the specific work on it, add explanations or visuals beside it,
bring in useful material, and help decide what to try next.

“A whiteboard you share with AI” is the simplest concrete description, but it
does not by itself explain the purpose. The board enables a different learning
relationship: the learner does the thinking and the work, while an intelligent
presence follows the process closely enough to guide it.

This is not primarily a place to request and consume answers. It is a place to
develop one's own understanding and approach to solving a problem.

## Why it exists

Chatbots tend to turn a question into an answer. That can resolve the immediate
question without helping the person build intuition about how to approach the
next one.

Recorded courses, videos, and general learning material have a different
limitation. They begin from a fixed baseline and follow a fixed progression.
A learner often has to move through material they already know while searching
for the explanation or exercise that fits the precise gap they have now. That
problem becomes more pronounced for specific, uncommon, or intermediate topics
that do not fit neatly into an available course or one teacher's specialty.

A good teacher can meet the learner where they are. They can recall a missing
formula, find a better representation, offer an exercise at the right level,
notice a misconception, give one useful nudge, or wait because the learner is
capable of finding the next step. Personal teaching of that kind is difficult
to find on demand, especially for a narrow topic, and can require cost,
scheduling, and a search for the right person.

The project explores how much of that relationship can be made available in a
space the learner can enter whenever they want to understand something.

## Who it is for

The first user is a self-directed person who wants to understand something or
work out a problem for themselves and would normally benefit from paper, a
whiteboard, diagrams, notation, or careful step-by-step reasoning.

They may be returning to material they partly remember, learning a new concept,
solving an exercise, investigating a specific technical question, or exploring
an idea with someone knowledgeable enough to guide the process. They do not
need to be enrolled in a course, following a syllabus, or working at a
particular school level.

The primary purpose is learning and understanding. Research can support that
purpose when the tutor needs to find accurate material, a source, an image, or
a useful explanation. General planning and outsourced knowledge work are not
the product's center.

## Learning by doing

The learner should remain the person doing the intellectual work.

They write the equation, make the diagram, try the derivation, explain an idea,
or test an approach. The tutor helps them acquire the concepts and tools needed
to continue, but should not automatically replace that process with a finished
solution.

The desired interaction often looks like this:

1. The learner says what they want to understand or improve at.
2. The tutor helps find a useful starting point and may place an exercise or
   material on the board.
3. The learner works through it in their own way.
4. The tutor looks at the actual attempt and responds to the current step.
5. Depending on the learner's intent and state, the tutor corrects a
   misconception, gives a small nudge, supplies missing knowledge, offers a new
   challenge, or waits.

The goal is not to enforce one pedagogical script. Sometimes the learner wants
an explanation. Sometimes they want the smallest possible hint. Sometimes they
want to brainstorm, see a concept represented visually, recall something they
once knew, or be challenged with more difficult material. The tutor has to
understand which interaction is wanted instead of treating every question as a
request for an answer.

When a learner asks “How do I solve this?”, the tutor should consider whether
they are asking for the solution, for a way into the problem, or for support
while they solve it themselves.

## The shared board

The board is not decoration for a chat and not merely a place where the tutor
displays an answer. It is the shared working context.

Handwriting matters because it lets the learner think in their own way, as they
would on paper. With Apple Pencil they can calculate, draw, annotate, cross
things out, and develop an idea without translating every intermediate thought
into a prompt. That active process distinguishes the experience from
continually asking a chatbot questions and consuming its responses.

Apple Pencil and iPad are the clearest current expression of the experience,
and it is appropriate to name them in current product copy. They are not a
claim that the idea can only exist on one device. Handwriting and direct
manipulation are the lasting principles; other useful surfaces, such as a web
app used with a drawing tablet, may express them later.

Because both participants work in the same space, the tutor can respond beside
the relevant line, draw a diagram, add notation, correct or extend its own
material, place a researched image, or create an exercise where the learner
will work. The learner should not have to describe an expression or diagram
that is already in front of both of them.

## Voice is part of the workspace

Voice is a primary part of the experience, not an accessibility add-on or a
faster way to fill a text box.

The learner can close or minimize chat, enter voice mode, keep writing, and
talk naturally with the same tutor that sees and acts on the board. The useful
mental model is working at a whiteboard with an intelligent being: speaking,
thinking, writing, looking at the same material, and returning to silence when
the learner wants to concentrate.

The tutor should be able to discuss the work, inspect it, place material on the
board, and respond through voice without feeling like a separate voice agent
handing work to another system. The experience should read as one tutor in one
shared space.

The quality, speed, and continuity of this interaction will improve as the
models and product integration improve. Those implementation details are not
the vision and should not be marketed as a feature roadmap. Do not anchor the
product story to a model name.

## The role of the tutor

The tutor should know more than the learner about the material at hand, or be
able to research what it needs, but knowledge alone is not enough. Its role is
to help the learner build understanding.

A strong tutor:

- understands the learner's current intent before deciding how to respond;
- works from the exact writing, diagrams, and context on the board;
- gives material and exercises appropriate to the learner's current level;
- protects learner-led problem solving instead of casually revealing the next
  step or final answer;
- recognizes when a nudge, correction, explanation, challenge, or pause is
  useful;
- can research and bring accurate information or images into the explanation;
- uses the board as an ordinary part of teaching, not as an occasional visual
  flourish;
- remembers relevant goals, preferences, earlier work, strengths, gaps, and
  unresolved questions across sessions; and
- adapts when the learner's goal or preferred depth changes.

The tutor should not assume that constant intervention is helpful. An important
part of the desired relationship is knowing when the learner can continue alone
and leaving them room to do it.

## Freedom instead of a fixed course

The product is not defined by generating courses or making the learner follow a
predetermined sequence.

The learner can begin with the particular thing they want to understand now,
including something narrow, unusual, between established subjects, or beyond
what they remember from school. The tutor can find a starting point from the
learner's actual baseline, bring in prerequisite knowledge when it becomes
necessary, create a fitting exercise, and go deeper or change direction with
them.

Plans, roadmaps, progress, sessions, and generated material can support this
experience. They are not the identity of the product. A plan is useful when the
learner wants one; it should not turn an open learning space into a course the
learner has to obey.

## Personalization and memory

Memory is expected infrastructure for a personal tutor, not a novelty to brag
about on its own.

Personalization means that the tutor increasingly understands who the learner
is in this context: what they want to achieve, where they currently stand, what
they already understand, what they have forgotten, which approaches help them,
what they have been working through, and where they left off.

That context should make the choice of explanation, exercise, challenge, and
amount of help more appropriate. The product should describe the benefit—being
met at the right level and continuing with context—rather than making a vague
claim that “it remembers you.”

## Scope

The interaction is not inherently specific to mathematics. A shared board is
especially useful wherever writing, diagrams, notation, visual explanation,
calculation, or systematic reasoning are part of understanding. The founder
imagines uses across technical and scientific material, among other things,
but does not want the product reduced to a catalogue of subjects.

Product copy should therefore be subject-agnostic without using empty claims
such as “learn anything” or implying equally mature support for every possible
domain. Explain the learning process and the shared workspace; let examples
show its range when examples are useful.

## The product now

Most of the intended interaction already exists as a baseline: a learner can
write on the board, talk with the tutor, ask it to inspect work, receive
guidance and exercises, have the tutor draw or place material on the board,
research information, and continue with personal context.

The product is not waiting for a separate future feature set to become this
idea. It is already an early version of it. The work ahead is largely
incremental: improve the quality and speed of each part, make the parts work
together more reliably, and cross the threshold where the whole interaction
feels natural and dependable.

Public copy should present the intended integrated experience directly. It
does not need a “future vision” section or a list of speculative media and
model capabilities. It also should not describe every intermediary feature.
The vision is the relationship between learner, tutor, voice, and shared board.

This does not justify making precise claims that the current product cannot
support. Describe the experience confidently, but do not promise continuous
observation, perfect judgment, universal subject expertise, or other behavior
as guaranteed if it remains inconsistent.

## What the experience should leave behind

After a session, the learner should feel that they understood the subject or
solved the problem for themselves—not that an AI completed it on their behalf.

The experience should feel lighter and less burdensome than searching for the
right course, teacher, or isolated explanation. It should still challenge the
learner. The hoped-for result is an “aha” moment followed by curiosity: this is
interesting; I want to try another problem; I want to understand what is
possible next.

## How to communicate it

Lead with the concrete experience:

- a shared whiteboard;
- the learner writing and working things out;
- a tutor they can speak with;
- both participants seeing and acting on the same work; and
- guidance that helps the learner find the next step without taking the work
  away from them.

Then explain the deeper benefit: the learner can start from their own level,
explore the particular material they care about, and develop their own
understanding without fitting themselves to a fixed course.

Use plain, specific language. Avoid catchphrases, inflated claims, generic AI
language, obvious feature statements, and copy that tries to sound impressive
without explaining the experience.

The product must not sound like:

- a homework-answering app;
- a generic chatbot with a whiteboard attached;
- a course generator or adaptive study-plan engine;
- school or classroom management software;
- a general productivity whiteboard; or
- an artificial teacher that claims perfect knowledge or judgment.

## Open language decisions

The founder has not settled on one permanent name for the intelligent presence.
Each option emphasizes something real and loses something:

- **Tutor** is immediately understandable and communicates guidance,
  personalization, and learning, but can sound narrower or more school-like
  than the full relationship.
- **Assistant** is broad but can imply a system that performs work for the user,
  which conflicts with learner-led understanding.
- **Collaborator** reflects shared work but can sound corporate and does not
  immediately communicate teaching.
- **Companion** communicates presence and continuity but not knowledge or
  pedagogical judgment.
- **AI** is simple but says almost nothing about the role.

Until this is resolved, **tutor** is acceptable in interface and public copy
because it is the clearest existing term and the founder repeatedly uses it.
Strategic documents should not turn that practical choice into a final naming
decision. Phrases such as “intelligent tutor” or “a tutor that shares your
board” can clarify the role without inventing a new category name.

The product name is also unresolved. **Learn AI** is a working name. New copy
should avoid wordplay or claims that depend on keeping it.
