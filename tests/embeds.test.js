import { describe, it, expect } from 'vitest';
import {
  THEME,
  truncate,
  progressBar,
  trackLink,
  buildNowPlayingEmbed,
  buildQueueEmbed,
  buildQueuedEmbed,
  pausedMessage,
  resumedMessage,
  skippedMessage,
  stoppedMessage,
} from '../src/utils/embeds.js';

describe('truncate', () => {
  it('mantém textos curtos intactos', () => {
    expect(truncate('ChicoBot', 20)).toBe('ChicoBot');
  });

  it('não altera texto no limite exato', () => {
    expect(truncate('abcdef', 6)).toBe('abcdef');
  });

  it('corta acima do limite com reticências e respeita o máximo', () => {
    const result = truncate('a'.repeat(50), 10);

    expect(result).toBe(`${'a'.repeat(9)}…`);
    expect(Array.from(result)).toHaveLength(10);
  });

  it('trunca por code points sem quebrar emojis', () => {
    const result = truncate('🎵'.repeat(20), 5);

    expect(Array.from(result)).toHaveLength(5);
    expect(result.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF]$/.test(result)).toBe(false);
  });

  it('limite inválido ou zero devolve vazio', () => {
    expect(truncate('abc', 0)).toBe('');
    expect(truncate('abc', -1)).toBe('');
    expect(truncate(null, 10)).toBe('');
  });
});

describe('progressBar', () => {
  it('barra vazia em 0%', () => {
    expect(progressBar(0, 100, 10)).toBe('○'.repeat(10));
  });

  it('barra cheia em 100%', () => {
    expect(progressBar(100, 100, 10)).toBe('▬'.repeat(10));
  });

  it('barra meio a meio', () => {
    expect(progressBar(50, 100, 10)).toBe('▬▬▬▬▬○○○○○');
  });

  it('duração desconhecida ou zero não gera barra', () => {
    expect(progressBar(10, null)).toBeNull();
    expect(progressBar(10, 0)).toBeNull();
  });

  it('progresso além da duração é limitado ao máximo', () => {
    expect(progressBar(500, 100, 10)).toBe('▬'.repeat(10));
    expect(progressBar(-5, 100, 10)).toBe('○'.repeat(10));
  });
});

describe('trackLink', () => {
  it('gera link clicável com duração', () => {
    const link = trackLink({ title: 'Faixa', url: 'https://youtu.be/x', duration: 180 });

    expect(link).toBe('**[Faixa](https://youtu.be/x)** (3:00)');
  });

  it('trunca títulos muito grandes', () => {
    const link = trackLink({ title: 'x'.repeat(300), url: 'https://youtu.be/x', duration: 10 }, 50);

    expect(link).toContain(`${'x'.repeat(49)}…`);
  });

  it('sem faixa devolve marcador textual', () => {
    expect(trackLink(null)).toBe('*Nada tocando.*');
  });
});

describe('buildNowPlayingEmbed', () => {
  const track = {
    title: 'Faixa de teste',
    url: 'https://www.youtube.com/watch?v=abc123',
    duration: 180,
    requestedBy: 'tester#0001',
    thumbnail: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
  };

  it('monta título clicável, thumbnail, cor, autor e campos', () => {
    const embed = buildNowPlayingEmbed({
      track,
      state: 'playing',
      progress: { positionSeconds: 45, durationSeconds: 180, percent: 25 },
      queueLength: 3,
      client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
    });

    const data = embed.toJSON();

    expect(data.title).toBe('Faixa de teste');
    expect(data.url).toBe('https://www.youtube.com/watch?v=abc123');
    expect(data.color).toBe(0x3b82f6);
    expect(data.thumbnail.url).toBe('https://i.ytimg.com/vi/abc123/hqdefault.jpg');
    expect(data.author.name).toBe('ChicoBot • Tocando agora');
    expect(data.author.icon_url).toBe('https://cdn.example/avatar.png');
    expect(data.footer.text).toBe('ChicoBot • 3 na fila');

    const progressField = data.fields.find((field) => field.name === '⏱️ Progresso');
    expect(progressField.value).toContain('0:45 / 3:00 • 25%');
    expect(progressField.value.split('\n')[1]).toBe('▬▬▬○○○○○○○○○');

    expect(data.fields.find((field) => field.name === '🎧 Pedido por').value).toBe('tester#0001');
    expect(data.fields.find((field) => field.name === '📋 Fila').value).toBe('3 música(s)');
  });

  it('estado pausado usa a cor cinza e o rótulo Pausado', () => {
    const data = buildNowPlayingEmbed({ track, state: 'paused', progress: null }).toJSON();

    expect(data.color).toBe(THEME.colors.paused);
    expect(data.author.name).toBe('ChicoBot • Pausado');
    expect(data.footer.text).toBe('ChicoBot • 0 na fila');
  });

  it('sem thumbnail não define a imagem', () => {
    const data = buildNowPlayingEmbed({
      track: { ...track, thumbnail: null },
      state: 'playing',
    }).toJSON();

    expect(data.thumbnail).toBeUndefined();
  });

  it('duração desconhecida mostra tempo sem barra de progresso', () => {
    const data = buildNowPlayingEmbed({
      track: { ...track, duration: null },
      state: 'playing',
      progress: { positionSeconds: 12, durationSeconds: null, percent: null },
    }).toJSON();

    const value = data.fields.find((field) => field.name === '⏱️ Progresso').value;

    expect(value).toBe('0:12 / —');
    expect(value.split('\n')).toHaveLength(1);
  });

  it('funciona sem client (sem ícone no autor)', () => {
    const data = buildNowPlayingEmbed({ track, state: 'playing' }).toJSON();

    expect(data.author.icon_url).toBeUndefined();
  });
});

describe('buildQueueEmbed', () => {
  const current = {
    title: 'Tocando agora',
    url: 'https://www.youtube.com/watch?v=now',
    duration: 200,
    requestedBy: 'pedidor#0001',
    thumbnail: 'https://i.ytimg.com/vi/now/hqdefault.jpg',
  };

  const upcoming = (count) =>
    Array.from({ length: count }, (_, index) => ({
      title: `Próxima ${index + 1}`,
      url: `https://www.youtube.com/watch?v=q${index + 1}`,
      duration: 100 + index,
      requestedBy: 'outro#0002',
    }));

  it('destaca a faixa atual e lista as próximas', () => {
    const embed = buildQueueEmbed({
      snapshot: {
        state: 'playing',
        current,
        queue: upcoming(12),
        queueLength: 12,
        progress: { positionSeconds: 20, durationSeconds: 200, percent: 10 },
      },
      guildName: 'Servidor Chico',
      previewLimit: 10,
      client: { user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' } },
    });

    const data = embed.toJSON();

    expect(data.color).toBe(0x3b82f6);
    expect(data.author.name).toBe('ChicoBot • Fila — Servidor Chico');
    expect(data.thumbnail.url).toBe('https://i.ytimg.com/vi/now/hqdefault.jpg');
    expect(data.footer.text).toBe('ChicoBot • 12 na fila • mostrando 10');
    expect(data.description).toContain('▶️ **Tocando agora**');
    expect(data.description).toContain('**[Tocando agora](https://www.youtube.com/watch?v=now)** (3:20)');
    expect(data.description).toContain('Pedido por **pedidor#0001**');
    expect(data.description).toContain('0:20 / 3:20 • 10%');
    expect(data.description).toContain('**📋 Próximas**');
    expect(data.description).toContain('1. **[Próxima 1](');
    expect(data.description).toContain('… e mais 2 na fila.');
  });

  it('fila maior que o preview corta e informa o excedente', () => {
    const data = buildQueueEmbed({
      snapshot: { state: 'playing', current, queue: upcoming(15), queueLength: 15 },
      previewLimit: 10,
    }).toJSON();

    expect(data.description).toContain('10. **[Próxima 10](');
    expect(data.description).not.toContain('11. **[Próxima 11](');
    expect(data.description).toContain('… e mais 5 na fila.');
  });

  it('sem música atual e fila vazia não lança (regressão do crash)', () => {
    const data = buildQueueEmbed({
      snapshot: { state: 'idle', current: null, queue: [], queueLength: 0 },
      guildName: null,
    }).toJSON();

    expect(data.author.name).toBe('ChicoBot • Fila');
    expect(data.description).toContain('⏹️ **Nada tocando**');
    expect(data.description).toContain('*Nada na fila.*');
    expect(data.footer.text).toBe('ChicoBot • 0 na fila • mostrando 0');
  });

  it('estado pausado usa a cor cinza', () => {
    const data = buildQueueEmbed({
      snapshot: { state: 'paused', current, queue: [], queueLength: 0 },
    }).toJSON();

    expect(data.color).toBe(THEME.colors.paused);
    expect(data.description).toContain('⏸️ **Pausado**');
  });

  it('respeita o limite do preview padrão quando não informado', () => {
    const data = buildQueueEmbed({
      snapshot: { state: 'playing', current, queue: upcoming(11), queueLength: 11 },
    }).toJSON();

    expect(data.footer.text).toBe('ChicoBot • 11 na fila • mostrando 10');
  });
});

describe('buildQueuedEmbed', () => {
  it('mostra posição, fila, pedido por e cor da identidade', () => {
    const data = buildQueuedEmbed({
      track: {
        title: 'Nova faixa',
        url: 'https://www.youtube.com/watch?v=new',
        duration: 90,
        requestedBy: 'tester#0001',
        thumbnail: 'https://i.ytimg.com/vi/new/hqdefault.jpg',
      },
      position: 3,
      queueLength: 5,
    }).toJSON();

    expect(data.color).toBe(THEME.colors.music);
    expect(data.author.name).toBe('ChicoBot • Adicionada à fila');
    expect(data.title).toBe('Nova faixa');
    expect(data.url).toBe('https://www.youtube.com/watch?v=new');
    expect(data.thumbnail.url).toBe('https://i.ytimg.com/vi/new/hqdefault.jpg');
    expect(data.fields.find((field) => field.name === '📍 Posição').value).toBe('#3');
    expect(data.fields.find((field) => field.name === '🎧 Pedido por').value).toBe('tester#0001');
    expect(data.fields.find((field) => field.name === '📋 Fila').value).toBe('5 música(s)');
    expect(data.footer.text).toBe('ChicoBot • use /nowplaying para ver o progresso');
  });
});

describe('mensagens efêmeras padrão', () => {
  const track = { title: 'Faixa', url: 'https://youtu.be/x', duration: 180 };

  it('/pause usa o formato padrão com link', () => {
    expect(pausedMessage(track)).toBe('⏸️ **Música pausada.** **[Faixa](https://youtu.be/x)** (3:00) — use `/resume` para continuar.');
  });

  it('/resume usa o formato padrão com link', () => {
    expect(resumedMessage(track)).toBe('▶️ **Música retomada.** **[Faixa](https://youtu.be/x)** (3:00)');
  });

  it('/skip mostra a faixa atual e a próxima', () => {
    const next = { title: 'Segunda', url: 'https://youtu.be/y', duration: 60 };

    expect(skippedMessage(track, next)).toBe(
      '⏭️ Pulando **[Faixa](https://youtu.be/x)** (3:00). Próxima: **[Segunda](https://youtu.be/y)** (1:00)'
    );
  });

  it('/skip sem próxima informa fila vazia', () => {
    expect(skippedMessage(track, null)).toBe('⏭️ Pulando **[Faixa](https://youtu.be/x)** (3:00). *Fila vazia.*');
  });

  it('/stop usa o formato padrão', () => {
    expect(stoppedMessage()).toBe('⏹️ **Fila encerrada.** Desconectando do canal de voz.');
  });
});
