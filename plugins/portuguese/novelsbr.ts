import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters } from '@libs/filterInputs';
import { load as parseHTML } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

class NovelsBRPlugin implements Plugin.PluginBase {
  id = 'novelsbr';
  name = 'Novels BR';
  icon = 'src/pt-br/novelsbr/icon.png';
  site = 'https://novels-br.com';
  version = '1.0.3';
  filters: Filters | undefined = undefined;

  private months: Record<string, string> = {
    janeiro: '01',
    fevereiro: '02',
    março: '03',
    marco: '03',
    abril: '04',
    maio: '05',
    junho: '06',
    julho: '07',
    agosto: '08',
    setembro: '09',
    outubro: '10',
    novembro: '11',
    dezembro: '12',
  };

  private parsePtDate(dateStr: string): string | undefined {
    if (!dateStr) return undefined;

    const match = dateStr
      .toLowerCase()
      .match(
        /(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})(?:\s+as?\s+(\d{1,2}):(\d{2}))?/,
      );

    if (!match) return undefined;

    const day = match[1].padStart(2, '0');
    const month = this.months[match[2]] || '01';
    const year = match[3];
    const hour = (match[4] || '00').padStart(2, '0');
    const minute = (match[5] || '00').padStart(2, '0');

    return `${year}-${month}-${day}T${hour}:${minute}:00`;
  }

  async popularNovels(
    pageNo: number,
    _options: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    // A paginação do site começa em 0
    const page = pageNo - 1;
    const url = `${this.site}/novels?page=${page}`;

    const body = await fetchApi(url).then(r => r.text());
    const $ = parseHTML(body);
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    // Cards da página /novels
    $('.card').each((_, el) => {
      const link = $(el).find('a.custom-link').attr('href') || '';
      if (!link || !link.startsWith('/novels/')) return;
      if (link.includes('capitulo') || link.includes('volume-')) return;
      if (seen.has(link)) return;
      seen.add(link);

      const name = $(el).find('h2.card-title').text().trim();
      if (!name) return;

      let cover =
        $(el).find('img.custom-card-img, img').first().attr('src') ||
        defaultCover;

      if (cover && !cover.startsWith('http')) {
        cover = this.site + (cover.startsWith('/') ? cover : '/' + cover);
      }

      novels.push({
        name,
        path: link,
        cover,
      });
    });

    // Fallback: se não achou pelos cards, tenta os da home (product__item)
    if (novels.length === 0) {
      $('.product__item').each((_, el) => {
        const a = $(el).find('h5 a').first();
        const href = a.attr('href') || '';
        if (!href || seen.has(href)) return;
        seen.add(href);

        const name = a.text().trim();
        let cover =
          $(el).find('.product__item__pic').attr('data-setbg') ||
          $(el).find('img').attr('src') ||
          defaultCover;

        if (cover && !cover.startsWith('http')) {
          cover = this.site + (cover.startsWith('/') ? cover : '/' + cover);
        }

        if (name) {
          novels.push({ name, path: href, cover });
        }
      });
    }

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url =
      this.site + (novelPath.startsWith('/') ? novelPath : `/${novelPath}`);
    const body = await fetchApi(url).then(r => r.text());
    const $ = parseHTML(body);

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: $('h1').first().text().trim() || 'Sem título',
      cover: $('img.header-img, #heroimg').first().attr('src') || defaultCover,
      chapters: [],
    };

    const author = $('h3').first().text().trim();
    if (author) novel.author = author;

    const statusText = ($('h5').first().text() || '').toLowerCase();
    novel.status = statusText.includes('conclu')
      ? NovelStatus.Completed
      : NovelStatus.Ongoing;

    const genres: string[] = [];
    const h4 = $('h4').first().text() || '';
    h4.split(/[-–|/]/).forEach(g => {
      const t = g.trim();
      if (t) genres.push(t);
    });
    $('a[href*="categoryId"]').each((_, el) => {
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });
    if (genres.length) novel.genres = genres.join(', ');

    novel.summary =
      $('section.navbar-novel p, #hero-novel p, .col-md-6 p')
        .first()
        .text()
        .trim() || '';

    const chapters: Plugin.ChapterItem[] = [];
    const seen = new Set<string>();

    $('#volumes a[href*="/novels/"], .accordion-body a').each((_, el) => {
      let href = $(el).attr('href') || '';
      if (!href) return;
      if (href.startsWith('http')) href = href.replace(this.site, '');
      if (!href.startsWith('/')) href = '/' + href;
      if (seen.has(href)) return;
      seen.add(href);

      const name =
        $(el).find('strong').text().trim() ||
        $(el)
          .clone()
          .children('small, br')
          .remove()
          .end()
          .text()
          .replace(/\d{1,2} de \w+ de \d{4}.*/i, '')
          .trim();

      const rawDate = $(el).find('small').text().trim();
      const releaseTime = this.parsePtDate(rawDate);

      if (name) {
        chapters.push({
          name,
          path: href,
          releaseTime,
        });
      }
    });

    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url =
      this.site +
      (chapterPath.startsWith('/') ? chapterPath : `/${chapterPath}`);
    const body = await fetchApi(url).then(r => r.text());
    const $ = parseHTML(body);

    $('.chapter-content a.page-link').remove();

    let content = $('.chapter-content').html() || '';

    content = content
      .replace(/Leia em https?:\/\/[^\s<]+/gi, '')
      .replace(/<a class="page-link"[^>]*>[\s\S]*?<\/a>/gi, '')
      .replace(/Comentem e Avaliem o Capítulo![\s\S]*$/i, '')
      .trim();

    return content;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // Por enquanto filtra a listagem (o site não tem busca real fácil)
    const all = await this.popularNovels(pageNo, {} as any);
    const term = searchTerm.toLowerCase().trim();
    if (!term) return all;
    return all.filter(n => n.name.toLowerCase().includes(term));
  }

  resolveUrl = (path: string) => {
    if (path.startsWith('http')) return path;
    return this.site + (path.startsWith('/') ? path : `/${path}`);
  };
}

export default new NovelsBRPlugin();
