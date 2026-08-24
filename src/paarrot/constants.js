/** Paarrot / Matrix custom event & property names (wire-compatible). */

const StateEvent = {
  RoomEmbedFilters: 'im.paarrot.room.embed_filters',
  SubRooms: 'im.paarrot.sub_rooms',
  RoomKind: 'im.paarrot.room.kind',
  CallMember: 'org.matrix.msc3401.call.member',
  RoomEmotes: 'im.ponies.room_emotes',
  PowerLevelTags: 'in.cinny.room.power_level_tags',
};

const AccountData = {
  EmbedFilters: 'im.paarrot.embed_filters',
  FavEmojis: 'paarrot.favemojis',
  UserEmotes: 'im.ponies.user_emotes',
  EmoteRooms: 'im.ponies.emote_rooms',
  RecentEmoji: 'io.element.recent_emoji',
};

const RoomKind = {
  ForumSpace: 'forum_space',
  Forum: 'forum',
};

const RoomType = {
  Space: 'm.space',
  Forum: 'm.forum',
};

const Profile = {
  /** Paarrot-extended profile style blob (gradients, nameplate, etc.). */
  Colors: 'paarrot.colors',
  /** MSC4133 profile banner. */
  BannerUrl: 'm.banner_url',
  /** MSC4522 username colors (stable). */
  ColorPreference: 'm.color_preference',
  /** MSC4522 unstable prefix while the MSC is open. */
  ColorPreferenceUnstable: 'eu.she-a.color',
};

const Carousel = {
  Uuid: 'com.paarrot.carousel_uuid',
  Index: 'com.paarrot.carousel_index',
  Total: 'com.paarrot.carousel_total',
};

const LOCAL_API_PORT = Number(process.env.RELAY_PAARROT_API_PORT || 33384);
const LOCAL_API_HOST = process.env.RELAY_PAARROT_API_HOST || '127.0.0.1';

module.exports = {
  StateEvent,
  AccountData,
  RoomKind,
  RoomType,
  Profile,
  Carousel,
  LOCAL_API_PORT,
  LOCAL_API_HOST,
};
