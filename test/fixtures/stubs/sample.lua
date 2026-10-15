local util = require("util")

local LIMIT = 10

-- Sum the numbers in a file, one per line.
local function sum_file(path)
  -- TODO(pi)
end

function M.get(key)
  return util.max(key, LIMIT)
end
