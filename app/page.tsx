'use client';

import Link from 'next/link';
import { Header } from './protect/_lib/Shell';
import { Reveal } from './protect/_lib/Reveal';
import {
  IconChain,
  IconFloor,
  IconLive,
  IconScan,
  IconSelfCustody,
  IconSpeak,
  IconUmbrella,
} from './protect/_lib/Icons';
import styles from './page.module.css';

const STEPS = [
  {
    Icon: IconSpeak,
    num: '01',
    title: 'Tell us your goal',
    body: 'Tell Payung what you need protected, in plain language.',
    tag: '"I need my 1 ETH worth at least $2,300"',
  },
  {
    Icon: IconScan,
    num: '02',
    title: 'Payung finds protection',
    body: 'We read the live Thetanuts book and show you the best match, priced.',
    tag: 'Live market data',
  },
  {
    Icon: IconFloor,
    num: '03',
    title: 'Confirm & protect',
    body: 'See the payoff, simulate it, sign it from your own wallet.',
    tag: 'On-chain proof',
  },
];

const FEATURES = [
  { Icon: IconSelfCustody, title: 'Keep your ETH', body: 'Your crypto stays in your wallet the whole time. Payung never takes custody.' },
  { Icon: IconLive, title: 'Live pricing', body: 'Quotes are sourced from live Thetanuts option markets, not estimates.' },
  { Icon: IconFloor, title: 'No options expertise', body: 'State a goal in plain English. Payung translates it into the right contract.' },
  { Icon: IconChain, title: 'On-chain proof', body: 'Every protection is a verifiable on-chain position on Base.' },
];

/**
 * The one thing this product does that nothing else does: a sentence becomes a
 * priced, fillable on-chain position. Showing that transformation literally is
 * a stronger opening argument than a grid of feature cards describing it.
 */
function TransformStrip() {
  return (
    <div className={styles.transform} aria-label="How a sentence becomes protection">
      <Reveal as="div" className={styles.transformCell}>
        <p className={styles.transformLabel}>You say</p>
        <p className={styles.transformSentence}>“Keep my 1 ETH worth at least $2,300 for the next two weeks.”</p>
      </Reveal>
      <span className={styles.transformArrow} aria-hidden="true" />
      <Reveal as="div" delay={120} className={styles.transformCell}>
        <p className={styles.transformLabel}>Payung reads it as</p>
        <div className={styles.transformChips}>
          <span className={styles.transformChip}>1 ETH</span>
          <span className={[styles.transformChip, styles.transformChipFloor].join(' ')}>$2,300 protected price</span>
          <span className={styles.transformChip}>14 days</span>
        </div>
      </Reveal>
      <span className={styles.transformArrow} aria-hidden="true" />
      <Reveal as="div" delay={240} className={styles.transformCell}>
        <p className={styles.transformLabel}>And buys</p>
        <p className={styles.transformResult}>
          A live Thetanuts put on Base: <span className={styles.transformFloorText}>$2,300</span> protected price,
          settled on-chain.
        </p>
      </Reveal>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div>
      <Header />

      <section className={styles.hero}>
        <Reveal as="h1" className={styles.headline}>
          Protect your downside.
          <br />
          <span className={styles.headlineAccent}>Keep</span> your upside.
        </Reveal>
        <Reveal as="p" delay={80} className={styles.subcopy}>
          Say what you&apos;re afraid of losing. Payung turns it into a real, live-quoted protected price for your
          crypto, without selling it or learning options jargon.
        </Reveal>
        <Reveal delay={160}>
          <Link href="/protect" className={styles.cta}>
            <IconUmbrella size={18} /> Protect my crypto
          </Link>
        </Reveal>
        <Reveal as="div" delay={240} className={styles.poweredBy}>
          <span>Powered by</span>
          <span className={styles.poweredByItem}>Thetanuts</span>
          <span className={styles.poweredByDot} />
          <span className={styles.poweredByItem}>Base</span>
        </Reveal>
      </section>

      <section className={styles.transformSection}>
        <TransformStrip />
      </section>

      <section className={styles.section} id="how-it-works">
        <h2 className={styles.sectionTitle}>How Payung works</h2>
        <div className={styles.stepsGrid}>
          {STEPS.map(({ Icon, ...step }, i) => (
            <Reveal as="div" delay={i * 90} className={styles.stepCard} key={step.num}>
              <div className={styles.stepIconRow}>
                <span className={styles.iconBox}>
                  <Icon size={24} />
                </span>
                <span className={[styles.stepNum, 'num'].join(' ')}>{step.num}</span>
              </div>
              <h3 className={styles.cardTitle}>{step.title}</h3>
              <p className={styles.cardBody}>{step.body}</p>
              <span className={styles.tag}>{step.tag}</span>
            </Reveal>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Why Payung</h2>
        <div className={styles.featuresGrid}>
          {FEATURES.map(({ Icon, ...f }, i) => (
            <Reveal as="div" delay={i * 80} className={styles.featureCard} key={f.title}>
              <span className={styles.iconBox}>
                <Icon size={22} />
              </span>
              <h3 className={[styles.cardTitle, styles.featureTitle].join(' ')}>{f.title}</h3>
              <p className={styles.cardBody}>{f.body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <Reveal as="div" className={styles.finalCta}>
        <span className={styles.finalCtaIcon}>
          <IconUmbrella size={40} />
        </span>
        <div className={styles.finalCtaText}>
          <h2 className={styles.finalCtaTitle}>Ready to protect your crypto?</h2>
          <p className={styles.finalCtaBody}>Your goal, translated into live on-chain protection in minutes.</p>
        </div>
        <Link href="/protect" className={styles.cta}>
          <IconUmbrella size={18} /> Protect my crypto
        </Link>
      </Reveal>
    </div>
  );
}
