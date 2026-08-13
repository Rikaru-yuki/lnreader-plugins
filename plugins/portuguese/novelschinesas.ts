import { fetchApi } from '@libs/fetch';
import { Plugin } from '@/types/plugin';
import { Filters } from '@libs/filterInputs';
import { load as parseHTML } from 'cheerio';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';

class NovelsChinesasPlugin implements Plugin.PluginBase {
  id = 'novelschinesas';
  name = 'Novels Chinesas';
  icon = 'src/pt/novelschinesas/icon.png';
  site = 'https://novelschinesas.com';
  version = '1.0.1';
  filters: Filters | undefined = undefined;

  async popularNovels(
    pageNo: number,
    _options: Plugin.PopularNovelsOptions,
  ): Promise<Plugin.NovelItem[]> {
    const url = `${this.site}/wp-json/wp/v2/categories?per_page=100&page=${pageNo}&orderby=count&order=desc`;

    const response = await fetchApi(url);
    const categories = await response.json();

    if (!Array.isArray(categories)) return [];

    const novels: Plugin.NovelItem[] = [];

    for (const cat of categories) {
      if (!cat.count || cat.count < 5) continue;
      if (!cat.slug || cat.slug.includes('uncategorized')) continue;

      novels.push({
        name: cat.name,
        path: `/novel/${cat.slug}/`,
        cover:
          this.extractCoverFromDescription(cat.description) || defaultCover,
      });
    }

    return novels;
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const slug = novelPath.replace(/^\/novel\//, '').replace(/\/$/, '');

    // Busca a category pelo slug
    const catUrl = `${this.site}/wp-json/wp/v2/categories?slug=${encodeURIComponent(slug)}`;
    const catRes = await fetchApi(catUrl);
    const cats = await catRes.json();

    if (!Array.isArray(cats) || cats.length === 0) {
      throw new Error('Novel não encontrada');
    }

    const category = cats[0];
    const categoryId = category.id;

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: category.name,
      cover:
        this.extractCoverFromDescription(category.description) || defaultCover,
      summary: this.cleanDescription(category.description),
      chapters: [],
    };

    // Informações extras da página
    try {
      const pageUrl = `${this.site}/novel/${slug}/`;
      const pageBody = await fetchApi(pageUrl).then(r => r.text());
      const $ = parseHTML(pageBody);

      if ($('.completed, .sign-completed').length) {
        novel.status = NovelStatus.Completed;
      } else if ($('.ongoing, .sign-ongoing').length) {
        novel.status = NovelStatus.Ongoing;
      }

      const authorText = $('.js-full-content, .entry-content').text();
      const authorMatch = authorText.match(/Autor[^\n:]*[:\s]+([^\n<]+)/i);
      if (authorMatch) {
        novel.author = authorMatch[1].trim();
      }

      const genres: string[] = [];
      $('.tag a, span.tag a').each((_, el) => {
        const g = $(el).text().trim();
        if (g) genres.push(g);
      });
      if (genres.length) novel.genres = genres.join(', ');

      const betterCover = $('.post__img img, .js-full-content img')
        .first()
        .attr('src');
      if (betterCover) novel.cover = betterCover;
    } catch (e) {
      // continua só com os dados da API
    }

    // Busca todos os capítulos via API
    const chapters: Plugin.ChapterItem[] = [];
    let page = 1;
    const perPage = 100;
    let totalPages = 1;

    do {
      const postsUrl = `${this.site}/wp-json/wp/v2/posts?categories=${categoryId}&per_page=${perPage}&page=${page}&orderby=date&order=asc&_fields=id,title,link,slug,date`;

      const postsRes = await fetchApi(postsUrl);

      const totalHeader = postsRes.headers.get('X-WP-TotalPages');
      if (totalHeader) totalPages = parseInt(totalHeader, 10);

      const posts = await postsRes.json();
      if (!Array.isArray(posts) || posts.length === 0) break;

      for (const post of posts) {
        let path = post.link.replace(this.site, '');
        if (!path.startsWith('/')) path = '/' + path;

        let name = post.title?.rendered || post.slug;
        name = name
          .replace(/&amp;/g, '&')
          .replace(/&#8211;/g, '–')
          .replace(/&#8217;/g, "'")
          .replace(new RegExp(`^${category.name}\\s*`, 'i'), '')
          .trim();

        chapters.push({
          name,
          path,
          releaseTime: post.date,
        });
      }

      page++;
    } while (page <= totalPages);

    novel.chapters = chapters;
    return novel;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url =
      this.site +
      (chapterPath.startsWith('/') ? chapterPath : '/' + chapterPath);
    const body = await fetchApi(url).then(r => r.text());
    const $ = parseHTML(body);

    $(
      '.code-block, script, style, .comments-area, .post-top-prev-next, .post-bottom-prev-next, .js-remove, .edit-post-btn',
    ).remove();

    let content =
      $('.js-full-content').html() || $('.entry-content').html() || '';

    content = content
      .replace(/<h2[^>]*>.*?<\/h2>/gi, '')
      .replace(/<h3[^>]*>.*?<\/h3>/gi, '')
      .replace(/<h6[^>]*>.*?<\/h6>/gi, '')
      .replace(/Autor:.*?<\/p>/gi, '')
      .replace(/Tradução:.*?<\/p>/gi, '')
      .replace(/<div class="code-block[\s\S]*?<\/div>/gi, '');

    return content.trim();
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const url = `${this.site}/wp-json/wp/v2/categories?search=${encodeURIComponent(searchTerm)}&per_page=50&page=${pageNo}`;

    const response = await fetchApi(url);
    const categories = await response.json();

    if (!Array.isArray(categories)) return [];

    return categories
      .filter((cat: any) => cat.count > 0)
      .map((cat: any) => ({
        name: cat.name,
        path: `/novel/${cat.slug}/`,
        cover:
          this.extractCoverFromDescription(cat.description) || defaultCover,
      }));
  }

  private extractCoverFromDescription(description: string = ''): string | null {
    if (!description) return null;
    const match = description.match(/src="([^"]+\.(jpg|jpeg|png|webp)[^"]*)"/i);
    return match ? match[1] : null;
  }

  private cleanDescription(description: string = ''): string {
    if (!description) return '';
    return description
      .replace(/\[caption[\s\S]*?\[\/caption\]/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  resolveUrl = (path: string) => {
    if (path.startsWith('http')) return path;
    return this.site + (path.startsWith('/') ? path : '/' + path);
  };
}

export default new NovelsChinesasPlugin();
