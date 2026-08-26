import {
  Brand,
  Button,
  CapabilityCard,
  DeviceFrame,
  NewsletterForm,
  RoadmapCard,
} from './components';
import Image from 'next/image';

export default function Home() {
  return (
    <main>
      <header className="site-nav">
        <a className="brand-link" href="#top" aria-label="Learn AI home"><Brand /></a>
        <nav className="desktop-nav" aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="#how-it-works">How it works</a>
          <a href="#learners">For learners</a>
          <a href="#principles">Principles</a>
        </nav>
        <div className="nav-actions">
          <a className="sign-in" href="#newsletter">Sign in</a>
          <Button href="#testflight" size="small">Join TestFlight</Button>
        </div>
        <details className="mobile-menu">
          <summary aria-label="Toggle main menu"><span /><span /><span /></summary>
          <nav aria-label="Mobile navigation">
            <a href="#product">Product</a><a href="#how-it-works">How it works</a><a href="#learners">For learners</a><a href="#principles">Principles</a>
          </nav>
        </details>
      </header>
      <section className="hero" id="top">
        <div className="hero-copy">
          <h1><span>Learn anything.</span><span className="hero-line">A plan that <em>adapts.</em></span></h1>
          <p>Turn a goal into a living study plan. Read, write, and solve on one iPad canvas while Learn AI remembers what you know and chooses what comes next.</p>
          <div className="hero-actions">
            <Button href="#testflight">Join the TestFlight</Button>
            <Button href="#how-it-works" tone="secondary">See how it works</Button>
          </div>
        </div>
        <div className="hero-stage" aria-label="Learn AI running on an iPad">
          <Image className="mascot" src="/assets/learn-ai-mascot.png" width={180} height={158} alt="Learn AI mascot leaning on the iPad" />
          <DeviceFrame className="hero-device" />
        </div>
      </section>

      <section className="core-loop" id="how-it-works">
        <div className="section-heading">
          <h2>A learning engine, not another course.</h2>
          <p>The structure is simple: understand something, try it yourself, and let what happened change the next step.</p>
        </div>
        <div className="capability-grid">
          <CapabilityCard eyebrow="01 · Start with a goal" title="Say what you want to learn.">
            No intake questionnaire. A few well-chosen exercises reveal where you are more honestly than a checklist can.
          </CapabilityCard>
          <CapabilityCard eyebrow="02 · Learn by doing" title="Explanation and practice share one board.">
            Read a concept, write with Apple Pencil, select the step that is unclear, and keep moving without changing context.
          </CapabilityCard>
          <CapabilityCard eyebrow="03 · Adapt the plan" title="Each session starts from what changed.">
            Learn AI keeps a structured memory of the subject and the learner, then chooses the next useful material and exercise.
          </CapabilityCard>
        </div>
      </section>

      <section className="workspace-section" id="product">
        <div className="workspace-copy">
          <p className="eyebrow">THE WORKSPACE</p>
          <h2>The board is the lesson.</h2>
          <p className="section-body">Generated material and handwritten work live on one continuous surface. The tutor can look at the exact step you produced—not just a typed summary of it.</p>
          <ul className="feature-list">
            <li>Write naturally with Apple Pencil</li>
            <li>Ask about a selected step</li>
            <li>Receive instruction on the board</li>
          </ul>
        </div>
        <DeviceFrame compact className="workspace-device" />
      </section>

      <section className="memory-section" id="learners">
        <RoadmapCard />
        <div className="memory-copy">
          <p className="eyebrow">PERSISTENT CONTEXT</p>
          <h2>Day 34 should remember week 2.</h2>
          <p className="section-body">Learn AI keeps structured knowledge of the subject and of you: what you understand, where you hesitate, and how that changes over time.</p>
          <p>A broad roadmap stays visible.<br />Each session is generated against where you actually are when it begins—not against an old guess.</p>
          <p>“I don’t know” is useful information.<br />It routes to closer explanation and practice instead of becoming a penalty.</p>
        </div>
      </section>

      <section className="mission-section" id="principles">
        <h2>A tool for you to personalize your own education.</h2>
        <p>Not a fixed course and not a stream of plausible answers. Learn AI is being built to hold a coherent plan across weeks, produce material worth studying, and evaluate the reasoning in handwritten work—not only the final result.</p>
        <div className="mission-tags"><span>Any subject</span><span>Native iPad + Pencil</span><span>Adaptive by design</span></div>
      </section>

      <section className="beta-section" id="testflight">
        <div className="beta-panel">
          <span className="beta-orb beta-orb-left" aria-hidden="true" />
          <span className="beta-orb beta-orb-right" aria-hidden="true" />
          <h2>Help us test a different way to learn.</h2>
          <p>Join the iPad beta, or leave your email for occasional progress notes and the next TestFlight opening.</p>
          <div className="beta-actions">
            <Button href="#newsletter" tone="inverse">Join TestFlight</Button>
            <NewsletterForm />
          </div>
          <small>No launch spam. Unsubscribe whenever you like.</small>
        </div>
      </section>

      <footer className="site-footer">
        <div className="footer-main">
          <div className="footer-brand"><Brand /><p>A native iPad learning engine for studying through explanation, handwriting, and an adaptive plan.</p></div>
          <nav className="footer-links" aria-label="Footer navigation">
            <div><strong>Product</strong><a href="#how-it-works">How it works</a><a href="#testflight">TestFlight</a><a href="#top">Release notes</a></div>
            <div><strong>Project</strong><a href="#principles">Principles</a><a href="#top">Research</a><a href="#top">Privacy</a></div>
            <div><strong>Contact</strong><a href="#newsletter">Newsletter</a><a href="#newsletter">Feedback</a><a href="mailto:hello@learn-ai.app">Email</a></div>
          </nav>
        </div>
        <div className="footer-meta"><span>© 2026 Learn AI</span><span>Built to test capability before scale.</span></div>
      </footer>
    </main>
  );
}
