package demo

import kotlin.math.max
import java.io.File

private const val LIMIT = 10

/** Sum the numbers in a file, one per line. */
fun sumFile(path: String): Int {
    // TODO(pi)
    TODO()
}

class Cache {
    private var size = 0

    /** Keep the value for `key`. */
    fun put(key: String, value: Int) {
        // TODO(pi)
    }

    fun get(key: String): Int = max(size, LIMIT)
}
