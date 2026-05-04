/**
 * tweet-parser.js — GraphQL Response Normalizer
 *
 * Parses TweetDetail GraphQL responses and normalizes tweet data
 * into a canonical format matching the requirements spec.
 */

const TweetParser = (() => {

  // ============================================================================
  // Main Entry Point
  // ============================================================================

  /**
   * Parse a TweetDetail GraphQL response.
   * @param {Object} response — Raw GraphQL JSON
   * @returns {{ tweet: Object|null, replies: Object[] }}
   */
  function parseTweetDetailResponse(response) {
    try {
      // 1. Threaded conversation structure (Common for TweetDetail)
      const threadData = response?.data?.threaded_conversation_with_injections_v2;
      if (threadData) {
        const instructions = threadData.instructions || [];
        const addEntries = instructions.find(i => i.type === 'TimelineAddEntries');
        const entries = addEntries?.entries || [];

        // Root tweet
        const rootEntry = entries.find(e => e.entryId?.startsWith('tweet-'));
        const rootResult = rootEntry?.content?.itemContent?.tweet_results?.result;
        const tweet = rootResult ? normalizeTweet(rootResult) : null;

        // Reply threads
        const replies = [];
        const threads = entries.filter(e => e.entryId?.startsWith('conversationthread-'));
        for (const thread of threads) {
          const items = thread.content?.items || [];
          for (const item of items) {
            const replyResult = item?.item?.itemContent?.tweet_results?.result;
            if (replyResult && replyResult.__typename !== 'TweetTombstone') {
              const normalized = normalizeTweet(replyResult);
              if (normalized) replies.push(normalized);
            }
          }
        }
        return { tweet, replies };
      }

      // 2. Single tweet structure (Common for TweetResultByRestId)
      const singleResult = response?.data?.tweet_result?.result;
      if (singleResult) {
        console.log('[TweetParser] Found single tweet_result structure');
        const tweet = normalizeTweet(singleResult);
        return { tweet, replies: [] };
      }

      console.warn('[TweetParser] Response structure not recognized:', Object.keys(response?.data || {}));
      return { tweet: null, replies: [] };
    } catch (err) {
      console.error('[TweetParser] Error parsing TweetDetail response:', err);
      return { tweet: null, replies: [] };
    }
  }

  // ============================================================================
  // Tweet Normalization
  // ============================================================================

  /**
   * Normalize a single tweet result object.
   * Handles Tweet, TweetWithVisibilityResults, TweetTombstone.
   * @param {Object} result — tweet_results.result
   * @returns {Object|null}
   */
  function normalizeTweet(result) {
    if (!result) return null;

    // Handle special types
    const typename = result.__typename;
    if (typename === 'TweetTombstone') return null;
    if (typename === 'TweetWithVisibilityResults') {
      result = result.tweet;
      if (!result) return null;
    }

    const legacy = result.legacy || {};
    const user = result.core?.user_results?.result;

    // Tweet text: prefer note_tweet (long tweets) over full_text
    const text = result.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '';

    // Author
    const author = extractAuthor(user);

    // Engagement
    const engagement = {
      views: parseInt(result.views?.count || '0', 10),
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      quotes: legacy.quote_count || 0,
      bookmarks: legacy.bookmark_count || 0
    };

    // Media
    const rawMedia = legacy.extended_entities?.media || [];
    const media = rawMedia.map(m => ({
      type: m.type || 'photo',
      url: m.media_url_https || '',
      width: m.original_info?.width || 0,
      height: m.original_info?.height || 0,
      alt_text: m.ext_alt_text || null,
      video_url: getBestVideoUrl(m),
      duration_ms: m.video_info?.duration_millis || 0
    }));

    // Reply context
    const isReply = !!legacy.in_reply_to_status_id_str;
    const replyContext = {
      is_reply: isReply,
      in_reply_to_status_id: legacy.in_reply_to_status_id_str || null,
      in_reply_to_user_id: legacy.in_reply_to_user_id_str || null,
      in_reply_to_username: legacy.in_reply_to_screen_name || null
    };

    // Flags
    const flags = {
      is_reply: isReply,
      is_retweet: !!legacy.retweeted_status_result,
      is_quote: !!legacy.is_quote_status,
      is_sensitive: !!legacy.possibly_sensitive,
      has_community_notes: !!result.has_birdwatch_notes
    };

    // Entities
    const hashtags = (legacy.entities?.hashtags || []).map(h => h.text);
    const mentions = (legacy.entities?.user_mentions || []).map(m => ({
      username: m.screen_name,
      id: m.id_str
    }));
    const urls = (legacy.entities?.urls || []).map(u => ({
      expanded_url: u.expanded_url,
      display_url: u.display_url
    }));

    // Card / Poll
    const card = extractCard(result.card?.legacy);

    // Source — strip HTML tags
    const source = (result.source || '').replace(/<[^>]*>/g, '');

    // Build tweet URL
    const screenName = author.username || '';
    const tweetId = result.rest_id || '';
    const tweetUrl = screenName ? `https://x.com/${screenName}/status/${tweetId}` : '';

    return {
      id: tweetId,
      url: tweetUrl,
      text,
      lang: legacy.lang || '',
      created_at: legacy.created_at || '',
      conversation_id: legacy.conversation_id_str || '',
      source,

      author,
      engagement,
      media,

      hashtags,
      mentions,
      urls,

      ...replyContext,
      ...flags,

      card,

      extracted_at: new Date().toISOString()
    };
  }

  // ============================================================================
  // Author Extraction
  // ============================================================================

  function extractAuthor(userResult) {
    if (!userResult) return { id: '', username: '', display_name: '', bio: '', location: '',
      followers_count: 0, following_count: 0, tweet_count: 0, listed_count: 0,
      verified: false, professional_type: null, join_date: '', website_url: null,
      profile_image_url: '' };

    const userLegacy = userResult.legacy || {};
    const core = userResult.core || {};

    return {
      id: userResult.rest_id || '',
      username: core.screen_name || userLegacy.screen_name || '',
      display_name: core.name || userLegacy.name || '',
      bio: userResult.profile_bio?.description || userLegacy.description || '',
      location: userResult.location?.location || userLegacy.location || '',
      followers_count: userLegacy.followers_count || 0,
      following_count: userLegacy.friends_count || 0,
      tweet_count: userLegacy.statuses_count || 0,
      listed_count: userLegacy.listed_count || 0,
      verified: !!userResult.is_blue_verified,
      professional_type: userResult.professional?.professional_type || null,
      join_date: core.created_at || userLegacy.created_at || '',
      website_url: userLegacy.entities?.url?.urls?.[0]?.expanded_url || null,
      profile_image_url: userResult.avatar?.image_url || userLegacy.profile_image_url_https || ''
    };
  }

  // ============================================================================
  // Media Helpers
  // ============================================================================

  function getBestVideoUrl(mediaItem) {
    const variants = mediaItem?.video_info?.variants || [];
    const mp4s = variants.filter(v => v.content_type === 'video/mp4');
    if (mp4s.length === 0) return null;
    mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return mp4s[0].url || null;
  }

  // ============================================================================
  // Card / Poll Extraction
  // ============================================================================

  function extractCard(cardLegacy) {
    if (!cardLegacy) return null;

    const values = {};
    (cardLegacy.binding_values || []).forEach(bv => {
      if (bv.value?.string_value !== undefined) {
        values[bv.key] = bv.value.string_value;
      } else if (bv.value?.scribe_value?.description !== undefined) {
        values[bv.key] = bv.value.scribe_value.description;
      }
    });

    const card = {
      type: cardLegacy.name || '',
      title: values.title || '',
      description: values.description || '',
      url: values.card_url || '',
    };

    // Poll data
    if (cardLegacy.name?.includes('poll')) {
      card.poll_choices = [];
      for (let i = 1; i <= 4; i++) {
        const label = values[`choice${i}_label`];
        const count = values[`choice${i}_count`];
        if (label) {
          card.poll_choices.push({ label, count: count || '0' });
        }
      }
      card.poll_end_date = values.end_datetime_utc || null;
    }

    return card;
  }

  // ============================================================================
  // Public API
  // ============================================================================

  return {
    parseTweetDetailResponse,
    normalizeTweet,
    extractAuthor,
    getBestVideoUrl,
    extractCard
  };
})();
