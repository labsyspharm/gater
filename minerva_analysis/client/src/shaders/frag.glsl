#version 300 es
precision highp int;
precision highp float;
precision highp usampler2D;

uniform usampler2D u_ids;
uniform usampler2D u_tile;
uniform sampler2D u_gatings;
uniform usampler2D u_centers;
uniform sampler2D u_magnitudes;
uniform ivec2 u_ids_shape;
uniform vec2 u_tile_shape;
uniform ivec2 u_gating_shape;
uniform ivec3 u_center_shape;
uniform ivec3 u_magnitude_shape;

uniform float u_scale_level;
uniform vec2 u_tile_origin;
uniform vec2 u_tile_range;
uniform vec3 u_tile_color;
uniform bvec2 u_draw_mode;
uniform vec2 u_x_bounds;
uniform vec2 u_y_bounds;
uniform int u_tile_fmt;
uniform int u_id_end;

in vec2 uv;
out vec4 color;

// Fixed maximum number of ids
const uint MAX = uint(16384) * uint(16384);
const uint bMAX = uint(ceil(log2(float(MAX))));
// Fixed range of radians
const vec2 TAU = vec2(0., 6.2831853);
const float PI = 3.14159265;
// Fixed maximum number of channels
const int kMAX = 99;

// square given float
float pow2(float v) {
  return v * v;
}

// difference
float dx(vec2 v) {
  return v[1] - v[0];
}

// rgba to one integer
uint unpack(uvec4 id) {
  return id.x + uint(256)*id.y + uint(65536)*id.z + uint(16777216)*id.w;
}

// Check if value between min and max
bool check_range(float value, vec2 range) {
  float clamped = clamp(value, range.x, range.y);
  return (abs(clamped - value) == 0.0);
}

// Interpolate between domain and range
float linear(vec2 ran, float dom, float x) {
  float b = ran[0];
  float m = dx(ran) / dom; 
  return m * float(clamp(x, 0., dom)) + b;
}

// From screen to local tile coordinates
vec2 screen_to_tile(vec2 screen) {
  float x = linear(u_x_bounds, 1., screen.x);
  float y = linear(u_y_bounds, 1., screen.y);
  return vec2(x, y) * u_tile_shape;
}

// From global to local tile coordinates
vec2 global_to_tile(vec2 v) {
  float tile_scale = max(u_scale_level, 1.0);
  vec2 c = v / tile_scale - u_tile_origin;
  return vec2(c.x, u_tile_shape.y - c.y);
}

// Check if values in array match
bool check_same(uvec4 arr, ivec2 ii) {
  if (arr[ii.x] == arr[ii.y]) return true;
  return false;
}
bool check_same(uvec4 arr, ivec3 ii) {
  if (arr[ii.x] == arr[ii.y]) return true;
  if (arr[ii.y] == arr[ii.z]) return true;
  if (arr[ii.x] == arr[ii.z]) return true;
  return false;
}

// Float ratio of two integers
float division(int ai, int bi) {
  return float(ai) / float(bi);
}

// Float modulo of two integers
float modulo(uint ai, uint bi) {
  return mod(float(ai), float(bi));
}

// Turn 2D ratios to coordinates for 2D texture
vec2 to_texture_xy(vec2 s, float x, float y) {
  return vec2(x / s.x, 1.0 - (y + 0.5) / s.y);
}

// Turn 2D integers to coordinates for wrapped texture
// Note: needed for 2D textures larger than normal limits
vec2 to_flat_texture_xy(ivec3 shape, int cell_index, int d) {
  uint idx = uint(cell_index * shape.z + d);
  float idx_x = modulo(idx, uint(shape.x));
  float idx_y = floor(division(int(idx), shape.x));
  return to_texture_xy(vec2(shape.xy), idx_x, idx_y);
}

// Access cell center at cell index
vec2 sample_center(int cell_index) {
  ivec3 shape = u_center_shape;
  vec2 center_x = to_flat_texture_xy(shape, cell_index, 0);
  vec2 center_y = to_flat_texture_xy(shape, cell_index, 1);
  uint cx = unpack(texture(u_centers, center_x));
  uint cy = unpack(texture(u_centers, center_y));
  return vec2(cx, cy);
}

// Access marker key magnitude at cell index
float sample_magnitude(int cell_index, int key) {
  ivec3 shape = u_magnitude_shape;
  vec2 idx_2d = to_flat_texture_xy(shape, cell_index, key);
  return texture(u_magnitudes, idx_2d).r;
}

// Access marker key gating parameter
float sample_gating(float param, float key) {
  vec2 shape = vec2(u_gating_shape);
  vec2 idx_2d = to_texture_xy(shape, param, key);
  return texture(u_gatings, idx_2d).r;
}

// Access marker key gated min/max
vec2 sample_gating_range(float key) {
  float min_range = sample_gating(0., key);
  float max_range = sample_gating(1., key);
  return vec2(min_range, max_range);
}

// Access marker key gated color
vec3 sample_gating_color(float key) {
  float r = sample_gating(2., key);
  float g = sample_gating(3., key);
  float b = sample_gating(4., key);
  return vec3(r, g, b);
}

// Check if angle is within one evenly divided slice
bool match_angle(int count, int total, float rad) {
  float rad_min = linear(TAU, float(total), float(count) - 1.);
  float rad_max = linear(TAU, float(total), float(count));
  vec2 rad_range = vec2(rad_min, rad_max);
  return check_range(mod(rad + PI, TAU.y), rad_range);
}

// Access cell id at cell index
uint sample_id(uint idx) {
  vec2 shape = vec2(u_ids_shape);
  float idx_x = modulo(idx, uint(shape.x));
  float idx_y = floor(division(int(idx), int(shape.x)));
  vec2 ids_idx = to_texture_xy(shape, idx_x, idx_y);
  uvec4 m_value = texture(u_ids, ids_idx);
  return unpack(m_value);
}

// Sample texture at given texel offset
uvec4 offset(usampler2D sam, vec2 size, vec2 pos, vec2 off) {
  float x_pos = pos.x + off.x / size.x;
  float y_pos = pos.y + off.y / size.y;
  float x = linear(u_x_bounds, 1., x_pos);
  float y = linear(u_y_bounds, 1., y_pos);
  return texture(sam, vec2(x, y));
}

// Compare to neighborhood if high resolution
uint compare_neighborhood(vec2 off, uint ikey) {
  uint bg = uint(0);
  if (ikey > bg) {
    return ikey;
  }
  // List all neighbors
  uvec4 nkeys = uvec4(bg);
  for (int i = 0; i < 4; i++) {
    float ex = vec4(0, 0, 1, -1)[i];
    float ey = vec4(1, -1, 0, 0)[i];
    vec2 neighbor = off + vec2(ex, ey);
    nkeys[i] = unpack(offset(u_tile, u_tile_shape, uv, neighbor)); 
  }
  // Select if 2 identical cells or 3 identical background 
  if (ikey == bg) {
    for (int i = 0; i < 4; i++) {
      for (int ii = 0; ii < 6; ii++) {
        int j = ii % 3;
        int k = int(division(ii, 3));
        if (i == k || i == j) ii += 1;
        bool is_cell = nkeys[i] > bg;
        if (check_same(nkeys, ivec3(i, j, k))) ikey = nkeys[i];
        if (is_cell && check_same(nkeys, ivec2(i, j))) ikey = nkeys[i];
        if (is_cell && check_same(nkeys, ivec2(i, k))) ikey = nkeys[i];
      }
    }
  }
  return ikey;
}


// Sample index of cell at given offset
// Note: will be -1 if cell not in cell list
int sample_cell_index(vec2 off) {
  // Find cell id at given offset 
  uint ikey = unpack(offset(u_tile, u_tile_shape, uv, off));
  if (u_scale_level < 1.) { 
    ikey = compare_neighborhood(off, ikey);
  }

  // Array size
  uint first = uint(0);
  uint last = uint(u_id_end);

  // Return -1 if background
  if (ikey == uint(0)) {
    return -1;
  }

  // Search within log(n) runtime
  for (uint i = uint(0); i <= bMAX; i++) {
    // Evaluate the midpoint
    uint mid = (first + last) / uint(2);
    uint here = sample_id(mid);

    // Break if list gone
    if (first == last && ikey != here) {
      break;
    }

    // Search below midpoint
    if (here > ikey) last = mid;

    // Search above midpoint
    else if (ikey > here) first = mid;

    // Found at midpoint
    else return int(mid);
  }
  // Return -1 if id not in list
  return -1;
}

// Limit to available marker keys
bool catch_key(int key) {
  if (key >= u_gating_shape.y) {
    return true;
  }
  if (key >= u_magnitude_shape.z) {
    return true;
  }
  return false;
}

// Count total OR-mode pie chart slices 
int count_gated_keys(int cell_index) {
  int gated_total = 0;
  for (int key = 0; key <= kMAX; key++) {
    if (catch_key(key)) {
      break;
    }
    float scale = sample_magnitude(cell_index, key);
    vec2 range = sample_gating_range(float(key));
    if (check_range(scale, range)) {
      gated_total = gated_total + 1;
    }
  }
  return gated_total;
}

float distance (vec2 v) {
  return sqrt(pow2(v.x) + pow2(v.y));
}

// Colorize OR-mode pie chart slices 
vec4 to_chart_color(vec4 empty_pixel, int cell_index) {
  float max_r = 5.;
  vec2 global_center = sample_center(cell_index);
  vec2 center = global_to_tile(global_center);
  vec2 pos = screen_to_tile(uv);
  vec2 delta = pos - center;

  if (distance(delta) > max_r) {
    return empty_pixel;
  }
  float rad = atan(delta.y, delta.x);

  int gated_count = 0;
  int gated_total = count_gated_keys(cell_index);

  // Check each possible key for color
  for (int key = 0; key <= kMAX; key++) {
    if (catch_key(key)) {
      break;
    }
    float scale = sample_magnitude(cell_index, key);
    vec2 range = sample_gating_range(float(key));
    if (check_range(scale, range)) {
      gated_count = gated_count + 1;
      if (match_angle(gated_count, gated_total, rad)) {
        vec3 color = sample_gating_color(float(key));
        return vec4(color, 1.0);
      }
    }
  }
  return empty_pixel;
}

// Check if pixel is on a border
bool near_cell_edge() {
  int cell_index = sample_cell_index(vec2(0, 0));
  for (int i = 0; i < 4; i++) {
    float ex = vec4(0, 0, 1, -1)[i];
    float ey = vec4(1, -1, 0, 0)[i];
    int edge_index = sample_cell_index(vec2(ex, ey));
    if (cell_index != edge_index) {
      return true;
    }
  }
  return false;
}

// Colorize discrete u32 signal
vec4 u32_rgba_map(bvec2 mode) {
  int cell_index = sample_cell_index(vec2(0, 0));
  vec4 empty_pixel = vec4(0., 0., 0., 0.);
  vec4 white_pixel = vec4(1., 1., 1., 1.);
  bool use_chart = mode.y;
  bool use_edge = mode.x;

  if(any(mode)) {
    // Charts (top layer)
    if (use_chart && cell_index != -1) {
      vec4 chart_color = to_chart_color(empty_pixel, cell_index);
      if (!all(equal(chart_color, empty_pixel))) {
        return chart_color;
      }
    }
    // Borders (bottom layer)
    if (use_edge) {
      if (near_cell_edge()) {
        return white_pixel;
      }
      return empty_pixel;
    }
  }
  else {
    // Fill (bottom layer)
    if (cell_index > -1) {
      return white_pixel;
    }
  }
  // Background
  return empty_pixel;
}

// Clamp signal between given min/max
float range_clamp(float value) {
  float min_ = u_tile_range[0];
  float max_ = u_tile_range[1];
  return clamp((value - min_) / (max_ - min_), 0.0, 1.0);
}

// Colorize continuous u16 signal
vec4 u16_rg_range(float alpha) {
  uvec2 pixel = offset(u_tile, u_tile_shape, uv, vec2(0, 0)).rg;
  float value = float(pixel.r * uint(255) + pixel.g) / 65535.;

  // Threshhold pixel within range
  float pixel_val = range_clamp(value);

  // Color pixel value
  vec3 pixel_color = u_tile_color * pixel_val;
  return vec4(pixel_color, alpha);
}

//
// Entrypoint
//

void main() {
  if (u_tile_fmt == 32) {
    color = u32_rgba_map(u_draw_mode);
  }
  else {
    color = u16_rg_range(0.9);
  }
}
