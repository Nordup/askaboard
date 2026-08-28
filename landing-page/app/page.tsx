import {
  BetaAccessDialog,
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
        <a className="brand-link" href="#top" aria-label="Whiteboard AI home"><Brand /></a>
        <nav className="desktop-nav" aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="#how-it-works">How it works</a>
          <a href="#learners">Personal learning</a>
          <a href="#principles">Why Whiteboard AI</a>
        </nav>
        <div className="nav-actions">
          <a className="sign-in" href="#newsletter">Get updates</a>
          <Button href="#beta-access" size="small">Beta access</Button>
        </div>
        <details className="mobile-menu">
          <summary aria-label="Toggle main menu"><span /><span /><span /></summary>
          <nav aria-label="Mobile navigation">
            <a href="#product">Product</a><a href="#how-it-works">How it works</a><a href="#learners">Personal learning</a><a href="#principles">Why Whiteboard AI</a>
          </nav>
        </details>
      </header>
      <section className="hero" id="top">
        <div className="hero-copy">
          <h1><span>A personal tutor</span><span className="hero-line">On your <em>iPad</em></span></h1>
          <p>Explore ideas, solve problems, and learn with a tutor that follows your work.</p>
          <div className="hero-actions">
            <Button href="#beta-access">Request beta access</Button>
            <Button href="#newsletter" tone="secondary">Get updates</Button>
          </div>
        </div>
        <div className="hero-stage" aria-label="Whiteboard AI running on an iPad">
          <Image className="mascot" src="/assets/learn-ai-mascot.png" width={180} height={158} alt="Whiteboard AI mascot leaning on the iPad" />
          <DeviceFrame className="hero-device" />
        </div>
      </section>

      <section className="core-loop" id="how-it-works">
        <div className="section-heading">
          <h2>Start with a question</h2>
          <p>Write it on the board or say it aloud. Your tutor can see your work, understand what you are asking, and help you keep going.</p>
        </div>
        <div className="capability-grid">
          <CapabilityCard eyebrow="01 · Write" title="Write it out">
            Use Apple Pencil to write, draw, calculate, and try your own approach.
          </CapabilityCard>
          <CapabilityCard eyebrow="02 · Ask" title="Ask as you work">
            Speak naturally while your tutor follows the exact step you are working on.
          </CapabilityCard>
          <CapabilityCard eyebrow="03 · Continue" title="Keep going">
            Get a hint, explanation, diagram, or next problem without leaving your work.
          </CapabilityCard>
        </div>
      </section>

      <section className="workspace-section" id="product">
        <div className="workspace-copy">
          <p className="eyebrow">A SHARED WHITEBOARD</p>
          <h2>Your tutor sees the board</h2>
          <p className="section-body">Your writing, the problem, and the tutor&apos;s explanations stay in one place. Point to any step, ask about it, and continue on the same board.</p>
          <ul className="feature-list">
            <li>Write and draw with Apple Pencil</li>
            <li>Ask about the exact step you are working on</li>
            <li>See explanations next to your work</li>
          </ul>
        </div>
        <DeviceFrame compact className="workspace-device" />
      </section>

      <section className="memory-section" id="learners">
        <RoadmapCard />
        <div className="memory-copy">
          <p className="eyebrow">PERSONAL TO YOU</p>
          <h2>Continue where you left off</h2>
          <p className="section-body">Whiteboard AI remembers what you are learning, what you understand, and where you need more help.</p>
          <p><strong>Start with what matters now</strong><br />You do not need to repeat what you already know.</p>
          <p><strong>Get the next useful step</strong><br />Your work and questions help the tutor choose what comes next.</p>
        </div>
      </section>

      <section className="mission-section" id="principles">
        <h2>A tool for you to personalize your own education.</h2>
        <p>Not a fixed course and not a stream of plausible answers. Learn AI is being built to hold a coherent plan across weeks, produce material worth studying, and evaluate the reasoning in handwritten work, not only the final result.</p>
        <div className="mission-tags"><span>Any subject</span><span>Native iPad + Pencil</span><span>Adaptive by design</span></div>
      </section>

      <section className="beta-section" id="beta">
        <div className="beta-panel">
          <span className="beta-orb beta-orb-left" aria-hidden="true" />
          <span className="beta-orb beta-orb-right" aria-hidden="true" />
          <h2>Help us test a different way to learn.</h2>
          <p>Request access to the iPad beta, or leave your email for occasional progress notes.</p>
          <div className="beta-actions">
            <Button href="#beta-access" tone="inverse">Request access</Button>
            <NewsletterForm />
          </div>
          <small>Only occasional updates. Unsubscribe anytime.</small>
        </div>
      </section>

      <footer className="site-footer">
        <div className="footer-main">
          <div className="footer-brand"><Brand /><p>A personal tutor on your iPad for exploring ideas, solving problems, and learning through your own work.</p></div>
          <nav className="footer-links" aria-label="Footer navigation">
            <div><strong>Product</strong><a href="#how-it-works">How it works</a><a href="#beta">Beta access</a><a href="#top">Release notes</a></div>
            <div><strong>Project</strong><a href="#principles">Why Whiteboard AI</a><a href="#top">Research</a><a href="#top">Privacy</a></div>
            <div><strong>Contact</strong><a href="#newsletter">Newsletter</a><a href="#newsletter">Feedback</a><a href="mailto:nordup.ondr@gmail.com">Email</a></div>
          </nav>
        </div>
        <div className="footer-meta"><span>© 2026 Whiteboard AI</span><span>Write, ask, and learn on one shared board</span></div>
      </footer>
      <BetaAccessDialog />
    </main>
  );
}
