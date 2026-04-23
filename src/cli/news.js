import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { screenStocks } from '../analysis/screener.js';
import { getStockNews, fetchAllNews } from '../data/news.js';
import {
  scoreSentiment,
  classifySentiment,
} from '../listeners/news-monitor.js';
import { displayHeader } from './display.js';

/**
 * Run news digest: screen top N stocks, fetch news per stock, score sentiment, display.
 *
 * @param {object} options
 * @param {number} [options.topN=15] - Number of stocks
 * @param {boolean} [options.detail=false] - Show individual headlines
 */
export async function runNewsDigest(options = {}) {
  const { topN = 15, detail = false } = options;

  displayHeader(
    'Tradease News Digest',
    `Top ${topN} F&O stocks — consolidated news & sentiment`,
  );

  // Step 1: Screen stocks
  const screenSpinner = ora('Screening stocks...').start();
  let screened;
  try {
    screened = await screenStocks();
    screened = screened.slice(0, topN);
    screenSpinner.succeed(`Top ${screened.length} stocks screened`);
  } catch (err) {
    screenSpinner.fail(`Screening failed: ${err.message}`);
    return;
  }

  if (screened.length === 0) {
    console.log(chalk.gray('\n  No stocks passed screening.\n'));
    return;
  }

  // Step 2: Fetch news for each stock in parallel
  const newsSpinner = ora(
    `Fetching news for ${screened.length} stocks...`,
  ).start();

  const newsResults = await Promise.all(
    screened.map(async stock => {
      try {
        const articles = await getStockNews(stock.symbol);
        // Score each article
        const scored = articles.map(a => ({
          ...a,
          sentimentScore: scoreSentiment(a),
        }));
        const totalScore = scored.reduce((sum, a) => sum + a.sentimentScore, 0);
        const sentiment = classifySentiment(totalScore);
        return {
          symbol: stock.symbol,
          name: stock.name || stock.symbol,
          sector: stock.sector || '—',
          price: stock.price,
          changePct: stock.changePct,
          newsCount: articles.length,
          totalScore,
          sentiment,
          topHeadlines: scored
            .sort(
              (a, b) => Math.abs(b.sentimentScore) - Math.abs(a.sentimentScore),
            )
            .slice(0, 3),
        };
      } catch {
        return {
          symbol: stock.symbol,
          name: stock.name || stock.symbol,
          sector: stock.sector || '—',
          price: stock.price,
          changePct: stock.changePct,
          newsCount: 0,
          totalScore: 0,
          sentiment: 'neutral',
          topHeadlines: [],
        };
      }
    }),
  );

  newsSpinner.succeed(`News fetched for ${newsResults.length} stocks`);

  // Step 3: Display summary table
  console.log('');

  const table = new Table({
    head: [
      chalk.cyan('#'),
      chalk.cyan('Symbol'),
      chalk.cyan('Sector'),
      chalk.cyan('Price'),
      chalk.cyan('Chg%'),
      chalk.cyan('News'),
      chalk.cyan('Score'),
      chalk.cyan('Sentiment'),
    ],
    style: { head: [], border: ['gray'] },
    colWidths: [4, 14, 16, 10, 8, 6, 7, 16],
  });

  // Sort by absolute sentiment score (most impactful first)
  const sorted = [...newsResults].sort(
    (a, b) => Math.abs(b.totalScore) - Math.abs(a.totalScore),
  );

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const sentColor = r.sentiment.includes('positive')
      ? chalk.green
      : r.sentiment.includes('negative')
        ? chalk.red
        : chalk.gray;
    const scoreColor =
      r.totalScore > 0
        ? chalk.green
        : r.totalScore < 0
          ? chalk.red
          : chalk.gray;
    const chgColor = (r.changePct || 0) >= 0 ? chalk.green : chalk.red;
    const chgStr =
      r.changePct != null
        ? `${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(1)}%`
        : '—';

    const sentLabel = r.sentiment
      .replace('very_', '')
      .replace('_', ' ')
      .toUpperCase();
    const sentBadge =
      r.sentiment === 'very_positive'
        ? chalk.bgGreen.white.bold(` ${sentLabel} `)
        : r.sentiment === 'positive'
          ? chalk.green(sentLabel)
          : r.sentiment === 'very_negative'
            ? chalk.bgRed.white.bold(` ${sentLabel} `)
            : r.sentiment === 'negative'
              ? chalk.red(sentLabel)
              : chalk.gray(sentLabel);

    table.push([
      chalk.gray(String(i + 1)),
      chalk.white.bold(r.symbol),
      chalk.gray(r.sector),
      chalk.white(`₹${(r.price || 0).toLocaleString('en-IN')}`),
      chgColor(chgStr),
      r.newsCount > 0 ? chalk.white(String(r.newsCount)) : chalk.gray('0'),
      scoreColor(String(r.totalScore > 0 ? `+${r.totalScore}` : r.totalScore)),
      sentBadge,
    ]);
  }

  console.log(table.toString());

  // Step 4: Show top headlines per stock (if detail mode or always show top movers)
  const movers = sorted.filter(
    r => Math.abs(r.totalScore) >= 2 && r.topHeadlines.length > 0,
  );

  if (movers.length > 0) {
    console.log(chalk.bold.white('\n  Key Headlines (sentiment movers):\n'));

    for (const r of movers) {
      const sentColor = r.totalScore > 0 ? chalk.green : chalk.red;
      console.log(
        sentColor(
          `  ${r.symbol} (score: ${r.totalScore > 0 ? '+' : ''}${r.totalScore})`,
        ),
      );

      for (const h of r.topHeadlines) {
        const icon =
          h.sentimentScore > 0
            ? chalk.green('  +')
            : h.sentimentScore < 0
              ? chalk.red('  -')
              : chalk.gray('  ·');
        const title =
          h.title.length > 80 ? h.title.slice(0, 77) + '...' : h.title;
        console.log(`${icon} ${chalk.white(title)}`);
      }
      console.log('');
    }
  }

  if (detail) {
    // Show all headlines for all stocks
    const withNews = sorted.filter(
      r =>
        r.topHeadlines.length > 0 && !movers.find(m => m.symbol === r.symbol),
    );
    if (withNews.length > 0) {
      console.log(chalk.bold.white('\n  Other Headlines:\n'));
      for (const r of withNews) {
        console.log(chalk.gray(`  ${r.symbol}`));
        for (const h of r.topHeadlines) {
          const icon =
            h.sentimentScore > 0
              ? chalk.green('  +')
              : h.sentimentScore < 0
                ? chalk.red('  -')
                : chalk.gray('  ·');
          const title =
            h.title.length > 80 ? h.title.slice(0, 77) + '...' : h.title;
          console.log(`${icon} ${chalk.white(title)}`);
        }
        console.log('');
      }
    }
  }

  // Summary line
  const bullish = newsResults.filter(r =>
    r.sentiment.includes('positive'),
  ).length;
  const bearish = newsResults.filter(r =>
    r.sentiment.includes('negative'),
  ).length;
  const neutral = newsResults.filter(r => r.sentiment === 'neutral').length;

  console.log(chalk.gray('  ─'.repeat(28)));
  console.log(
    `  ${chalk.green(`Bullish: ${bullish}`)}  ${chalk.red(`Bearish: ${bearish}`)}  ${chalk.gray(`Neutral: ${neutral}`)}  ${chalk.white(`Total articles: ${newsResults.reduce((s, r) => s + r.newsCount, 0)}`)}`,
  );
  console.log('');
}
