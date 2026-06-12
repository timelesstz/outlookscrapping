// Lightweight "matrix rain" background, tinted red for the cyber-security theme.
// Pure canvas, no dependencies; pauses when the tab is hidden and respects the
// user's reduced-motion preference.
export function startCyberBackground(canvas) {
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (prefersReduced) return

  const ctx = canvas.getContext('2d')
  const glyphs = 'アカサタナハマヤラワ0123456789@.#$<>/\\{}[]ABCDEF'.split('')
  const fontSize = 16
  let columns = 0
  let drops = []
  let dpr = 1

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.floor(window.innerWidth * dpr)
    canvas.height = Math.floor(window.innerHeight * dpr)
    canvas.style.width = window.innerWidth + 'px'
    canvas.style.height = window.innerHeight + 'px'
    columns = Math.ceil(canvas.width / (fontSize * dpr))
    drops = new Array(columns).fill(0).map(() => Math.random() * -50)
  }

  function frame() {
    // translucent black fade leaves trailing tails
    ctx.fillStyle = 'rgba(10, 10, 15, 0.08)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.font = `${fontSize * dpr}px Consolas, monospace`

    for (let i = 0; i < columns; i++) {
      const x = i * fontSize * dpr
      const y = drops[i] * fontSize * dpr
      const ch = glyphs[(Math.random() * glyphs.length) | 0]
      // leading character is brighter
      ctx.fillStyle = Math.random() > 0.975 ? '#ff8a9a' : '#ff2d4f'
      ctx.fillText(ch, x, y)

      if (y > canvas.height && Math.random() > 0.975) drops[i] = 0
      drops[i] += 0.6
    }
  }

  let raf = null
  function loop() {
    frame()
    raf = requestAnimationFrame(loop)
  }

  function start() { if (!raf) loop() }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = null } }

  resize()
  window.addEventListener('resize', resize)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop()
    else start()
  })
  start()
}
