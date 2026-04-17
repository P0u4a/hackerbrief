export interface HNStory {
  id: number;
  title: string;
  url?: string;
  text?: string;
  by: string;
  score: number;
  descendants?: number;
  time: number;
}

export interface AlgoliaComment {
  id: number;
  text: string | null;
  author: string | null;
  children: AlgoliaComment[];
}

export interface DigestItem {
  objectID: string;
  title: string;
  url: string;
  hnUrl: string;
  author: string;
  points: number;
  numComments: number;
  createdAt: string;
  summary: string | null;
  commentSummary: string | null;
}

export interface FrontPageDigest {
  generatedAt: string;
  itemCount: number;
  items: DigestItem[];
}
