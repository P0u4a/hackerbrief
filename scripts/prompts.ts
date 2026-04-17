export const summarizePrompt = (
  content: string
) => `You are a concise technical writer. Summarize the following article. Focus on key points, technical details, and why it matters. If the content is primarily about partisan politics, elections, political campaigns, or political figures in a political context, respond with exactly "POLITICAL_CONTENT" and nothing else.
      <article>
        ${content}
      </article>`;

export const summarizeCommentsPrompt = (
  comments: string
) => `Summarize the general ideas being discussed and the overall sentiment in these Hacker News comments. Highlight key themes, notable insights, and whether the community response is generally positive, negative, or mixed. Keep it concise (2-3 short paragraphs).
      <comments>
        ${comments}
      </comments>`;
