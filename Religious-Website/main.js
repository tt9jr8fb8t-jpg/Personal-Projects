gsap.registerPlugin(ScrollTrigger);

// Smooth scroll
const lenis = new Lenis({
  smooth: true
});

function raf(time) {
  lenis.raf(time);
  requestAnimationFrame(raf);
}
requestAnimationFrame(raf);

// Hero animation
gsap.from(".hero h1", {
  y: 80,
  opacity: 0,
  duration: 1.4,
  ease: "power4.out"
});

gsap.from(".hero p", {
  y: 40,
  opacity: 0,
  delay: .4
});

// Orb floating
gsap.to(".orb", {
  x: 200,
  y: -200,
  repeat: -1,
  yoyo: true,
  duration: 8,
  ease: "sine.inOut"
});

// Pillars reveal
gsap.from(".pillar", {
  scrollTrigger: {
    trigger: ".pillars",
    start: "top 70%"
  },
  y: 80,
  opacity: 0,
  stagger: .2
});

// Horizontal scroll
const panels = gsap.utils.toArray(".panel");

gsap.to(panels, {
  xPercent: -100 * (panels.length - 1),
  ease: "none",
  scrollTrigger: {
    trigger: ".horizontal",
    pin: true,
    scrub: 1,
    end: () => "+=" + document.querySelector(".horizontal").offsetWidth
  }
});
