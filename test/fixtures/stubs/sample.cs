using System;
using System.IO;

namespace Demo
{
    public class Cache
    {
        int size = 0;

        /// Sum the numbers in a file, one per line.
        public int SumFile(string path)
        {
            // TODO(pi)
            throw new NotImplementedException();
        }

        public int Get(string key)
        {
            return Math.Max(size, 10);
        }
    }
}
